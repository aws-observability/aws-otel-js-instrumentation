// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { InstrumentationType, SNAPSHOT_SIGNAL_TYPE } from './types';
import { CaptureConfiguration, parseCaptureConfiguration } from './capture-configuration';

const DEFAULT_MAX_HITS = 100;
const MIN_MAX_HITS = 1;
const MAX_MAX_HITS = 1000;

/**
 * Parsed PROBE or BREAKPOINT instrumentation configuration from the API.
 *
 * For JavaScript, the location is identified by:
 * - FilePath: Source file path (primary identifier, suffix-matched)
 * - MethodName: Function or method name
 * - ClassName: Optional, for class methods
 * - CodeUnit: Optional, parsed but not used for resolution
 * - LineNumber: 0 = method-level, >0 = line-level
 *
 * PROBE: method-level only (lineNumber forced to 0), no expiry, unlimited hits.
 * BREAKPOINT: method-level or line-level, has expiresAt and maxHits.
 */
export interface InstrumentationConfiguration {
  codeUnit: string;
  className: string;
  methodName: string;
  lineNumber: number;
  filePath: string;
  captureConfig: CaptureConfiguration;
  locationHash: string;
  instrumentationType: InstrumentationType;
  instrumentationName: string;
  expiresAt: number | null; // epoch milliseconds
  maxHits: number;
  attributeFilters: Array<Record<string, string>>;
  arn: string;
  createdAt: number | null; // epoch milliseconds
  signalType: string;
}

function safeInt(value: unknown, defaultValue: number): number {
  if (value === null || value === undefined) return defaultValue;
  const num = typeof value === 'number' ? value : Number(value);
  if (isNaN(num) || !isFinite(num)) return defaultValue;
  return Math.floor(num);
}

function clampMaxHits(value: number): number {
  if (value < MIN_MAX_HITS) return MIN_MAX_HITS;
  if (value > MAX_MAX_HITS) return MAX_MAX_HITS;
  return value;
}

function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Try ISO 8601 format
    const ms = Date.parse(value);
    if (!isNaN(ms)) return ms;
    // Try epoch seconds
    const num = Number(value);
    if (!isNaN(num) && isFinite(num)) {
      // Heuristic: if < 1e12, treat as seconds; otherwise milliseconds
      return num < 1e12 ? num * 1000 : num;
    }
  }
  return null;
}

/**
 * Compute the internal registry key for this configuration.
 * Format: filePath:methodName:lineNumber
 *
 * This key determines "last writer wins" conflict resolution.
 */
export function computeRegistryKey(config: InstrumentationConfiguration): string {
  return `${config.filePath}:${config.methodName}:${config.lineNumber}`;
}

/**
 * Check if a configuration is line-level (lineNumber > 0).
 */
export function isLineLevel(config: InstrumentationConfiguration): boolean {
  return config.lineNumber > 0;
}

/**
 * Check if a configuration is permanent (PROBE type).
 */
export function isPermanent(config: InstrumentationConfiguration): boolean {
  return config.instrumentationType === InstrumentationType.PROBE;
}

/**
 * Parse an API response item into an InstrumentationConfiguration.
 *
 * Returns null for unparseable configs (error isolation — one bad config
 * doesn't affect others).
 *
 * API response structure:
 * {
 *   "InstrumentationType": "BREAKPOINT",
 *   "SignalType": "SNAPSHOT",
 *   "Location": {
 *     "CodeLocation": {
 *       "Language": "JavaScript",
 *       "CodeUnit": "",
 *       "ClassName": "OrderService",
 *       "MethodName": "processOrder",
 *       "FilePath": "src/services/orderService.js",
 *       "LineNumber": 42
 *     }
 *   },
 *   "LocationHash": "abc123",
 *   "CaptureConfiguration": { "CodeCapture": {...} },
 *   "ExpiresAt": "2026-01-23T10:36:51Z",
 *   "InstrumentationName": "my-probe",
 *   "AttributeFilters": [{"key": "value"}],
 *   "ARN": "arn:...",
 *   "CreatedAt": "2026-01-23T10:00:00Z"
 * }
 */
export function parseInstrumentationConfiguration(
  apiConfig: Record<string, unknown>
): InstrumentationConfiguration | null {
  try {
    // Extract Location union — unwrap CodeLocation
    const locationUnion = apiConfig.Location as Record<string, unknown> | null;
    if (!locationUnion) {
      diag.warn('DI: Missing Location in API config');
      return null;
    }

    const location = locationUnion.CodeLocation as Record<string, unknown> | null;
    if (!location) {
      diag.debug('DI: Skipping non-CodeLocation config');
      return null;
    }

    // Check language — only process JavaScript/Node.js configs
    const language = location.Language as string | null;
    if (!language || !['javascript', 'nodejs', 'node.js', 'node', 'js'].includes(language.toLowerCase())) {
      return null;
    }

    // Extract location fields
    const codeUnit = (location.CodeUnit as string) ?? '';
    const className = (location.ClassName as string) ?? '';
    const methodName = (location.MethodName as string) ?? '';
    const filePath = (location.FilePath as string) ?? '';

    // Validate required fields — for JS, FilePath is the primary identifier
    if (!filePath) {
      diag.warn('DI: Missing FilePath in config. Skipping.');
      return null;
    }

    // MethodName is required for method-level, but for line-level it's optional
    // We'll validate this contextually below

    // Parse instrumentation type
    const typeStr = apiConfig.InstrumentationType as string | null;
    let instrumentationType: InstrumentationType;
    if (!typeStr) {
      instrumentationType = InstrumentationType.BREAKPOINT;
    } else {
      const upper = typeStr.toUpperCase();
      if (upper === 'PROBE') {
        instrumentationType = InstrumentationType.PROBE;
      } else if (upper === 'BREAKPOINT') {
        instrumentationType = InstrumentationType.BREAKPOINT;
      } else {
        diag.warn(`DI: Invalid InstrumentationType '${typeStr}'. Defaulting to BREAKPOINT.`);
        instrumentationType = InstrumentationType.BREAKPOINT;
      }
    }

    // Parse instrumentation name
    const instrumentationName = (apiConfig.InstrumentationName as string) ?? '';

    // PROBE requires InstrumentationName
    if (instrumentationType === InstrumentationType.PROBE && !instrumentationName) {
      diag.warn(`DI: PROBE instrumentation for ${filePath}:${methodName} missing InstrumentationName. Skipping.`);
      return null;
    }

    // Parse line number
    let lineNumber = safeInt(location.LineNumber, 0);
    if (instrumentationType === InstrumentationType.PROBE && lineNumber > 0) {
      diag.debug(
        `DI: PROBE for ${filePath}:${methodName} has LineNumber ${lineNumber}. Forcing to 0 (method-level only).`
      );
      lineNumber = 0;
    }
    if (lineNumber < 0) {
      diag.warn(`DI: Invalid LineNumber ${lineNumber} for ${filePath}:${methodName}. Must be >= 0. Skipping.`);
      return null;
    }

    // For method-level (lineNumber=0), MethodName is required
    if (lineNumber === 0 && !methodName) {
      diag.warn(`DI: Method-level config for ${filePath} missing MethodName. Skipping.`);
      return null;
    }

    // Parse capture configuration
    const captureUnion = apiConfig.CaptureConfiguration as Record<string, unknown> | null;
    let captureData: Record<string, unknown> | null = null;
    if (captureUnion) {
      if (captureUnion.CodeCapture) {
        captureData = captureUnion.CodeCapture as Record<string, unknown>;
      } else if (Object.keys(captureUnion).length > 0) {
        // Backward compatibility: treat flat structure as CodeCapture
        captureData = captureUnion;
      }
    }
    const captureConfig = parseCaptureConfiguration(captureData);

    // Parse LocationHash
    const locationHash = (apiConfig.LocationHash as string) ?? '';

    // Parse expiry (ignored for PROBE)
    let expiresAt: number | null = null;
    if (instrumentationType === InstrumentationType.BREAKPOINT) {
      expiresAt = parseTimestamp(apiConfig.ExpiresAt);
    }

    // Parse max hits
    let maxHits: number;
    if (instrumentationType === InstrumentationType.PROBE) {
      maxHits = Number.MAX_SAFE_INTEGER;
    } else {
      maxHits = DEFAULT_MAX_HITS;
      const captureLimits = captureData?.CaptureLimits as Record<string, unknown> | null;
      if (captureLimits) {
        maxHits = clampMaxHits(safeInt(captureLimits.MaxHits, DEFAULT_MAX_HITS));
      }
    }

    // Parse attribute filters
    const filters = apiConfig.AttributeFilters as Array<Record<string, string>> | null;
    const attributeFilters = Array.isArray(filters) ? filters : [];

    // Parse ARN
    const arn = (apiConfig.ARN as string) ?? '';

    // Parse CreatedAt
    const createdAt = parseTimestamp(apiConfig.CreatedAt);

    // Parse SignalType
    const signalType = (apiConfig.SignalType as string) ?? SNAPSHOT_SIGNAL_TYPE;

    return {
      codeUnit,
      className,
      methodName,
      lineNumber,
      filePath,
      captureConfig,
      locationHash,
      instrumentationType,
      instrumentationName,
      expiresAt,
      maxHits,
      attributeFilters,
      arn,
      createdAt,
      signalType,
    };
  } catch (error) {
    diag.warn('DI: Failed to parse instrumentation configuration', error);
    return null;
  }
}
