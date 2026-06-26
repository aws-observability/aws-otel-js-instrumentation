// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration management for ServiceEvents instrumentation.
 *
 * Provides environment variable parsing and configuration defaults for all
 * ServiceEvents features including AST transformation, collectors, and exporters.
 */

import { diag } from '@opentelemetry/api';
import { minimatch } from 'minimatch';
import { LIB_VERSION } from '../version';
import { ResourceAttributes } from './models/resource-attributes';

/**
 * Extract service.name from OTEL_RESOURCE_ATTRIBUTES environment variable.
 *
 * Parses the comma-separated key=value pairs in OTEL_RESOURCE_ATTRIBUTES
 * looking for 'service.name'.
 *
 * Example: OTEL_RESOURCE_ATTRIBUTES='service.name=shoppingcart,deployment.environment=production'
 */
function getServiceNameFromResourceAttributes(): string | undefined {
  const envResources = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
  if (!envResources) {
    return undefined;
  }

  for (const pair of envResources.split(',')) {
    if (pair.includes('=')) {
      const [key, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (key.trim() === 'service.name') {
        return value.trim();
      }
    }
  }

  return undefined;
}

/**
 * Extract deployment environment from OTEL_RESOURCE_ATTRIBUTES environment variable.
 *
 * Parses the comma-separated key=value pairs in OTEL_RESOURCE_ATTRIBUTES
 * looking for 'deployment.environment.name' (preferred) or 'deployment.environment'.
 *
 * Example: OTEL_RESOURCE_ATTRIBUTES='service.name=shoppingcart,deployment.environment=production'
 */
function getEnvironmentFromResourceAttributes(): string | undefined {
  const envResources = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
  if (!envResources) {
    return undefined;
  }

  // Scan ALL pairs first — deployment.environment.name (newer OTel convention) wins
  // regardless of ordering. Returning on the first matching key would let the legacy
  // deployment.environment value win when it is listed before .name.
  let legacy: string | undefined;
  for (const pair of envResources.split(',')) {
    if (pair.includes('=')) {
      const [key, ...rest] = pair.split('=');
      const value = rest.join('=');
      const trimmedKey = key.trim();
      if (trimmedKey === 'deployment.environment.name') {
        return value.trim();
      }
      if (trimmedKey === 'deployment.environment' && legacy === undefined) {
        legacy = value.trim();
      }
    }
  }

  // No .name present — fall back to the legacy key if it was seen.
  return legacy;
}

/**
 * Configuration for ServiceEvents instrumentation.
 */
export interface ServiceEventsConfig {
  // Enable/Disable
  enabled: boolean; // OTEL_AWS_SERVICE_EVENTS_ENABLED
  serviceName: string; // OTEL_SERVICE_NAME or OTEL_RESOURCE_ATTRIBUTES[service.name]
  // Environment and SDK. Omitted (no sentinel) when none of
  // OTEL_RESOURCE_ATTRIBUTES[deployment.environment(.name)] / ENVIRONMENT are set.
  environment?: string;
  sdkVersion: string; // Internal — automatically fetched from ADOT package version, no env override
  // Flush Intervals (milliseconds). Internal — no env override; the first three are
  // reachable only through the test-config hook (see applyTestConfigHook).
  functionCallFlushInterval: number;
  endpointFlushInterval: number;
  incidentSnapshotFlushInterval: number;
  deploymentEventFlushInterval: number;
  // Incident Snapshot Settings. The rate-limit window is fixed at 1 minute;
  // only the per-minute ceiling is configurable.
  incidentSnapshotMaxPerMinute: number; // OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE
  incidentSnapshotDurationThresholdMs: number; // OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_DURATION_THRESHOLD_MS
  incidentSnapshotMaxSameError: number; // OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_SAME_ERROR
  // Per-endpoint latency thresholds for latency-triggered incident snapshots
  // Format: "METHOD /route:threshold_ms,METHOD /route:threshold_ms,..."
  // Example: "POST /api/checkout:500,GET /api/health:50,GET /api/reports:5000"
  latencyThresholds: string[]; // OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS
  // Endpoint Filtering - glob patterns in format "METHOD /route" or "* /route" or "METHOD *"
  // If includePatterns is set, only track matching endpoints; then excludePatterns removes from that set
  // Example: "GET /api/*,POST /api/*" or "* /health,* /metrics"
  endpointIncludePatterns: string[]; // OTEL_AWS_SERVICE_EVENTS_ENDPOINT_INCLUDE_PATTERNS
  endpointExcludePatterns: string[]; // OTEL_AWS_SERVICE_EVENTS_ENDPOINT_EXCLUDE_PATTERNS
  // Function instrumentation
  functionInstrumentEnabled: boolean; // OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED
  // Function-instrumentation denylist. Always wins over packagesInclude.
  packagesExclude: string[]; // OTEL_AWS_SERVICE_EVENTS_PACKAGES_EXCLUDE
  // Function-instrumentation allowlist. Empty = no functions instrumented (the only opt-in).
  packagesInclude: string[]; // OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE
  // Sampling Mode: "auto" (tiered), "always" (100%), "never" (0%)
  samplingMode: string; // OTEL_AWS_SERVICE_EVENTS_SAMPLING_MODE
  // Sampling Thresholds (for auto mode). Internal — no env override; the
  // tier thresholds/rates are reachable only through the test-config hook.
  sampleTier1Threshold: number;
  sampleTier2Threshold: number;
  sampleTier2Rate: number;
  sampleTier3Rate: number;
  // JS-only: auto-detach per-function instrumentation when call rate exceeds
  // threshold (calls/sec, 0 = disabled). Internal — no env override.
  functionDetachThreshold: number;
  // Local-testing file exporter. When set, replaces OTLP network exporters —
  // LOGS_ENDPOINT and METRICS_ENDPOINT are ignored while this is active.
  outputFile: string; // OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE (empty = disabled)
  // CloudWatch Logs log group / stream. Required when logsEndpoint points at
  // a direct-to-CloudWatch OTLP endpoint (`https://logs.{region}.amazonaws.com/v1/logs`)
  // — emitted as `x-aws-log-group` / `x-aws-log-stream` headers on every
  // signed request. Ignored in collector-proxied and file-export modes.
  // Internal — no env override; reachable only through the test-config hook.
  logGroup: string;
  logStream: string; // defaults to service_name when unset
  // Application Signals bundling. When true, ServiceEvents suppresses
  // aws.service_events.endpoint_summary LogRecords because App Signals already
  // carries equivalent per-endpoint duration and error metrics. The
  // EndpointMetricCollector still runs so latency histograms feed
  // IncidentSnapshot thresholds. Per-exception-type error metrics still emit.
  applicationSignalsEnabled: boolean; // OTEL_AWS_APPLICATION_SIGNALS_ENABLED
  // Resource attributes from OTel resource
  resourceAttributes: ResourceAttributes;
}

/** Default configuration values. */
const DEFAULTS: ServiceEventsConfig = {
  // Default false: OTEL_AWS_SERVICE_EVENTS_ENABLED is unset by default, and the outer
  // bundling gate in register.ts is authoritative for "should ServiceEvents run".
  // Callers that bypass that gate must set enabled=true explicitly.
  enabled: false,
  serviceName: 'UnknownService',
  // No environment default: omitted (undefined) when unset — no sentinel.
  environment: undefined,
  sdkVersion: LIB_VERSION,
  functionCallFlushInterval: 30000,
  endpointFlushInterval: 30000,
  incidentSnapshotFlushInterval: 10000,
  deploymentEventFlushInterval: 86_400_000,
  incidentSnapshotMaxPerMinute: 100,
  incidentSnapshotDurationThresholdMs: 5000,
  incidentSnapshotMaxSameError: 1,
  latencyThresholds: [],
  endpointIncludePatterns: [],
  endpointExcludePatterns: [],
  functionInstrumentEnabled: true,
  // Empty by default: there is no implicit default scope. Empty packagesInclude
  // means "no functions instrumented unless PACKAGES_INCLUDE is set". The
  // non-configurable SDK_SELF_EXCLUDE (in ast-transformation.ts) is the only
  // built-in filter.
  packagesExclude: [],
  packagesInclude: [],
  samplingMode: 'always',
  sampleTier1Threshold: 100,
  sampleTier2Threshold: 1000,
  sampleTier2Rate: 10,
  sampleTier3Rate: 100,
  functionDetachThreshold: 5000,
  outputFile: '',
  applicationSignalsEnabled: false,
  logGroup: '',
  logStream: '',
  resourceAttributes: new ResourceAttributes(),
};

// --- Env var parsing helpers ---

function getBool(envVar: string, defaultValue: boolean): boolean {
  return (process.env[envVar] ?? String(defaultValue)).toLowerCase() === 'true';
}

/**
 * Parse an int env var and clamp it to [min, max]. Out-of-range or non-numeric
 * values fall back to defaultValue (within range), with a one-time warn so a
 * footgun (e.g. a 0 sampling/threshold or a typo'd huge value) is visible rather
 * than silently degrading the agent. Used for env-reachable numeric knobs that
 * would otherwise crash, pin CPU, or disable a feature at extreme values.
 */
function getIntClamped(envVar: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    diag.warn(`ServiceEvents: ${envVar}="${raw}" is not an integer; using default ${defaultValue}`);
    return defaultValue;
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.min(max, Math.max(min, parsed));
    diag.warn(`ServiceEvents: ${envVar}=${parsed} out of range [${min}, ${max}]; clamping to ${clamped}`);
    return clamped;
  }
  return parsed;
}

function getStr(envVar: string, defaultValue: string): string {
  return process.env[envVar] ?? defaultValue;
}

function getList(envVar: string, defaultValue: string[]): string[] {
  const raw = process.env[envVar];
  if (raw) {
    return raw
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
  return defaultValue;
}

/**
 * Parse a package-pattern list env var, rejecting bare match-everything sentinels.
 *
 * Bare `*` and `**` are rejected as too broad: under minimatch's `matchBase: true`
 * they match every path, defeating the point of an explicit allowlist. Strip these
 * entries and warn — `diag.warn` rather than `diag.info` because we're silently
 * altering user-provided configuration, and info-level diag is often suppressed in
 * production OTel setups.
 *
 * An empty list instruments nothing — there is no implicit default scope (see the
 * scope rule in ast-transformation.ts).
 */
function getPatternList(envVar: string, defaultValue: string[]): string[] {
  const raw = getList(envVar, defaultValue);
  const rejected: string[] = [];
  const normalized: string[] = [];
  for (const item of raw) {
    if (item === '*' || item === '**') {
      rejected.push(item);
      continue;
    }
    normalized.push(item);
  }
  if (rejected.length > 0) {
    diag.warn(
      `ServiceEvents: ignoring match-everything entries ${JSON.stringify(rejected)} in ${envVar}; ` +
        'use specific package prefixes (e.g. src/myapp/**). An empty list instruments nothing.'
    );
  }
  return normalized;
}

/**
 * Get service name with fallback chain.
 *
 * Priority:
 * 1. OTEL_SERVICE_NAME environment variable
 * 2. service.name from OTEL_RESOURCE_ATTRIBUTES
 * 3. Default value
 */
function getServiceName(defaultValue: string): string {
  const fromEnv = process.env.OTEL_SERVICE_NAME;
  if (fromEnv) {
    return fromEnv;
  }

  const fromResources = getServiceNameFromResourceAttributes();
  if (fromResources) {
    return fromResources;
  }

  return defaultValue;
}

/**
 * Get environment with fallback chain.
 *
 * Priority:
 * 1. deployment.environment.name from OTEL_RESOURCE_ATTRIBUTES
 * 2. deployment.environment from OTEL_RESOURCE_ATTRIBUTES
 * 3. ENVIRONMENT environment variable
 *
 * Returns undefined when none are set — there is no "UnknownEnvironment"
 * sentinel; downstream emit paths omit the resource attribute / EMF dimension
 * entirely when environment is unset.
 */
function getEnvironment(): string | undefined {
  const fromResources = getEnvironmentFromResourceAttributes();
  if (fromResources) {
    return fromResources;
  }

  const fromEnv = process.env.ENVIRONMENT;
  if (fromEnv) {
    return fromEnv;
  }

  return undefined;
}

/**
 * Build ServiceEventsConfig from environment variables.
 *
 * Uses DEFAULTS as fallback when environment variables are not set.
 */
export function createServiceEventsConfigFromEnv(): ServiceEventsConfig {
  return applyTestConfigHook({
    // Enable/Disable
    enabled: getBool('OTEL_AWS_SERVICE_EVENTS_ENABLED', DEFAULTS.enabled),
    serviceName: getServiceName(DEFAULTS.serviceName),
    // Environment is still resolved from OTEL_RESOURCE_ATTRIBUTES/ENVIRONMENT (release
    // surface). sdkVersion is internal — always the ADOT package version, no env override.
    environment: getEnvironment(),
    sdkVersion: DEFAULTS.sdkVersion,
    // Flush Intervals — internal (no env override); defaults stand. The first three are
    // overridable via the test-config hook.
    functionCallFlushInterval: DEFAULTS.functionCallFlushInterval,
    endpointFlushInterval: DEFAULTS.endpointFlushInterval,
    incidentSnapshotFlushInterval: DEFAULTS.incidentSnapshotFlushInterval,
    deploymentEventFlushInterval: DEFAULTS.deploymentEventFlushInterval,
    // Incident Snapshot Settings. Window fixed at 1 minute; only the per-minute
    // ceiling is configurable.
    // Clamp env-reachable numeric knobs so extreme/zero/negative values can't
    // disable a feature, divide by zero, or run up unbounded work.
    incidentSnapshotMaxPerMinute: getIntClamped(
      'OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE',
      DEFAULTS.incidentSnapshotMaxPerMinute,
      1,
      100_000
    ),
    incidentSnapshotDurationThresholdMs: getIntClamped(
      'OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_DURATION_THRESHOLD_MS',
      DEFAULTS.incidentSnapshotDurationThresholdMs,
      1,
      3_600_000 // 1 hour
    ),
    incidentSnapshotMaxSameError: getIntClamped(
      'OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_SAME_ERROR',
      DEFAULTS.incidentSnapshotMaxSameError,
      1,
      100_000
    ),
    latencyThresholds: getList('OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS', DEFAULTS.latencyThresholds),
    // Endpoint Filtering
    endpointIncludePatterns: getList(
      'OTEL_AWS_SERVICE_EVENTS_ENDPOINT_INCLUDE_PATTERNS',
      DEFAULTS.endpointIncludePatterns
    ),
    endpointExcludePatterns: getList(
      'OTEL_AWS_SERVICE_EVENTS_ENDPOINT_EXCLUDE_PATTERNS',
      DEFAULTS.endpointExcludePatterns
    ),
    // Function instrumentation
    functionInstrumentEnabled: getBool(
      'OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED',
      DEFAULTS.functionInstrumentEnabled
    ),
    // Function-instrumentation denylist. Always wins over packagesInclude (rule 2 in
    // ast-transformation.ts). Bare '*' entries are normalized away.
    packagesExclude: getPatternList('OTEL_AWS_SERVICE_EVENTS_PACKAGES_EXCLUDE', DEFAULTS.packagesExclude),
    // Function-instrumentation allowlist. Empty = no functions instrumented (the only opt-in).
    packagesInclude: getPatternList('OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE', DEFAULTS.packagesInclude),
    // Sampling Mode
    samplingMode: getStr('OTEL_AWS_SERVICE_EVENTS_SAMPLING_MODE', DEFAULTS.samplingMode),
    // Sampling Thresholds — internal (no env override); the tier thresholds/rates are
    // overridable via the test-config hook.
    sampleTier1Threshold: DEFAULTS.sampleTier1Threshold,
    sampleTier2Threshold: DEFAULTS.sampleTier2Threshold,
    sampleTier2Rate: DEFAULTS.sampleTier2Rate,
    sampleTier3Rate: DEFAULTS.sampleTier3Rate,
    functionDetachThreshold: DEFAULTS.functionDetachThreshold,
    // Local-testing file exporter. Literal path; empty = disabled.
    outputFile: getStr('OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE', DEFAULTS.outputFile),
    applicationSignalsEnabled: getBool('OTEL_AWS_APPLICATION_SIGNALS_ENABLED', DEFAULTS.applicationSignalsEnabled),
    // CloudWatch Logs headers for direct-to-CW OTLP shipping — internal (no env
    // override); overridable via the test-config hook.
    logGroup: DEFAULTS.logGroup,
    logStream: DEFAULTS.logStream,
    // Resource attributes from OTEL_RESOURCE_ATTRIBUTES env var
    resourceAttributes: ResourceAttributes.fromEnvironment(),
  });
}

// --- Internal test-config hook ---

/**
 * Name of the internal, undocumented, test-only config hook env var.
 *
 * Deliberately not under the `OTEL_AWS_SERVICE_EVENTS_` prefix so a grep of the
 * release surface stays clean.
 */
export const TEST_CONFIG_HOOK_ENV = 'DEBUG_SE_TEST_CONFIG';

/** One-time WARN guard so the hook logs at most once per process. */
let testConfigHookWarned = false;

/**
 * Internal test-config hook (NOT for production use).
 *
 * Black-box contract/e2e suites run the SDK in a separate process and can only
 * inject config via env. A handful of internal knobs (flush intervals, sample
 * tiers, log group/stream) need to be
 * reachable from those harnesses without restoring per-var public env vars. This
 * hook reads a single delimited string `DEBUG_SE_TEST_CONFIG="KEY=value;KEY=value"`
 * where `KEY` is the former env-var suffix, and overrides only recognized keys on an
 * already-built config.
 *
 * Gated: a literal no-op (zero allocation, no log) when the env var is unset/empty.
 * Emits a one-time WARN when active. Unknown keys and unparsable values are
 * silently ignored, leaving the hardcoded default in place.
 */
export function applyTestConfigHook(config: ServiceEventsConfig): ServiceEventsConfig {
  const raw = process.env[TEST_CONFIG_HOOK_ENV];
  if (!raw) {
    return config;
  }
  if (!testConfigHookWarned) {
    testConfigHookWarned = true;
    diag.warn(
      `ServiceEvents: ${TEST_CONFIG_HOOK_ENV} is set — applying internal test config overrides. ` +
        'This is a test-only hook and is NOT for production use.'
    );
  }

  // Parse "KEY=value;KEY=value" into a map, skipping empty/malformed entries.
  const overrides = new Map<string, string>();
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    overrides.set(trimmed.substring(0, eq).trim(), trimmed.substring(eq + 1).trim());
  }

  const setInt = (key: string, apply: (value: number) => void): void => {
    const value = overrides.get(key);
    if (value === undefined || value === '') {
      return;
    }
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      apply(parsed);
    }
  };
  const setStr = (key: string, apply: (value: string) => void): void => {
    const value = overrides.get(key);
    if (value !== undefined && value !== '') {
      apply(value);
    }
  };

  setInt('FUNCTION_CALL_FLUSH_INTERVAL', v => (config.functionCallFlushInterval = v));
  setInt('ENDPOINT_FLUSH_INTERVAL', v => (config.endpointFlushInterval = v));
  setInt('INCIDENT_SNAPSHOT_FLUSH_INTERVAL', v => (config.incidentSnapshotFlushInterval = v));
  setInt('SAMPLE_TIER1_THRESHOLD', v => (config.sampleTier1Threshold = v));
  setInt('SAMPLE_TIER2_THRESHOLD', v => (config.sampleTier2Threshold = v));
  setInt('SAMPLE_TIER2_RATE', v => (config.sampleTier2Rate = v));
  setInt('SAMPLE_TIER3_RATE', v => (config.sampleTier3Rate = v));
  setStr('LOG_GROUP', v => (config.logGroup = v));
  setStr('LOG_STREAM', v => (config.logStream = v));

  return config;
}

/**
 * Parse latency_thresholds list into pattern -> threshold_ms tuples.
 *
 * Supports glob patterns using minimatch (*, ?, [seq], [!seq]).
 * Each entry should be in format "METHOD /route:threshold_ms".
 *
 * Examples:
 *   - "GET /api/users:500" - exact match
 *   - "* /server_request:50" - any method to /server_request
 *   - "GET /api/*:100" - any GET to /api/* routes
 *   - "* *:200" - all endpoints (catch-all)
 *
 * @returns Array of [pattern, threshold_ms] tuples. Order matters - first match wins.
 */
export function getLatencyThresholdPatterns(config: ServiceEventsConfig): Array<[string, number]> {
  const result: Array<[string, number]> = [];

  for (const entry of config.latencyThresholds) {
    const trimmed = entry.trim();
    if (!trimmed || !trimmed.includes(':')) {
      continue;
    }

    // Split on last colon to handle routes that might contain colons
    const lastColonIdx = trimmed.lastIndexOf(':');
    if (lastColonIdx <= 0) {
      continue;
    }

    const apiPart = trimmed.substring(0, lastColonIdx).trim();
    const thresholdPart = trimmed.substring(lastColonIdx + 1).trim();

    // Parse threshold. Reject non-finite and non-positive values: a 0 or negative
    // per-endpoint threshold would make EVERY request to the matching route exceed it
    // and fire a latency incident (the gate compares durationMs > thresholdMs). Skip
    // the entry so the route falls back to the global default instead.
    const thresholdMs = parseFloat(thresholdPart);
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
      diag.warn(`ServiceEvents: ignoring latency threshold "${trimmed}" — threshold must be a positive number of ms`);
      continue;
    }

    // Parse "METHOD /route" format
    const spaceIdx = apiPart.indexOf(' ');
    if (spaceIdx < 0) {
      continue;
    }

    const method = apiPart.substring(0, spaceIdx).trim().toUpperCase();
    const route = apiPart.substring(spaceIdx + 1).trim();

    // Store as pattern string "METHOD /route"
    const pattern = `${method} ${route}`;
    result.push([pattern, thresholdMs]);
  }

  return result;
}

/**
 * Check if an endpoint should be tracked based on include/exclude patterns.
 *
 * Filter logic:
 * 1. If includePatterns is empty -> track all endpoints (default)
 * 2. If includePatterns is set -> only track endpoints matching at least one include pattern
 * 3. Then, if excludePatterns is set -> remove any endpoints matching exclude patterns
 *
 * Patterns use glob-style matching (minimatch):
 * - "*" matches anything
 * - "?" matches any single character
 * - Format: "METHOD /route" (e.g., "GET /api/*", "* /health", "POST /api/users")
 *
 * @param config - ServiceEvents configuration
 * @param route - The endpoint route (e.g., "/api/users")
 * @param method - The HTTP method (e.g., "GET", "POST")
 * @returns True if the endpoint should be tracked, false if filtered out.
 */
export function shouldTrackEndpoint(config: ServiceEventsConfig, route: string, method: string): boolean {
  const endpointStr = `${method.toUpperCase()} ${route}`;

  // Step 1: Check include patterns
  if (config.endpointIncludePatterns.length > 0) {
    // Must match at least one include pattern
    let included = false;
    for (const pattern of config.endpointIncludePatterns) {
      if (minimatch(endpointStr, pattern)) {
        included = true;
        break;
      }
    }
    if (!included) {
      return false;
    }
  }

  // Step 2: Check exclude patterns
  if (config.endpointExcludePatterns.length > 0) {
    for (const pattern of config.endpointExcludePatterns) {
      if (minimatch(endpointStr, pattern)) {
        return false;
      }
    }
  }

  return true;
}
