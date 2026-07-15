// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';

/**
 * Configuration for Dynamic Instrumentation feature.
 *
 * Parsed from environment variables. Each variable is parsed independently
 * to isolate errors (one bad env var doesn't affect others).
 *
 * Env var precedence: API value > Environment variable > Hardcoded default.
 */
export interface DynamicInstrumentationConfig {
  enabled: boolean;
  apiUrl: string;
  probePollIntervalSeconds: number;
  breakpointPollIntervalSeconds: number;
  outputDirectory: string;
  logsEndpoint: string;
  serviceName: string;
  environment: string;
  /**
   * Resource attributes (string-valued) from the OTel SDK Resource, used to
   * evaluate AttributeFilters on instrumentation configurations. Populated by
   * the main thread from the configured Resource and passed to the worker; may
   * be empty if the resource was unavailable at startup.
   */
  resourceAttributes: Record<string, string>;
}

const DEFAULTS = {
  enabled: false,
  apiUrl: 'http://localhost:2000',
  probePollIntervalSeconds: 600,
  breakpointPollIntervalSeconds: 60,
  outputDirectory: 'aws-di-snapshots',
};

const POLL_INTERVAL_RANGE = { min: 5, max: 86400 }; // 5s to 24h

function getEnvStr(key: string, defaultValue: string): string {
  const value = process.env[key];
  if (value === null || value === undefined) return defaultValue;
  const trimmed = value.trim();
  return trimmed || defaultValue;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === null || value === undefined) return defaultValue;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return defaultValue;
}

function getEnvInt(key: string, defaultValue: number, min: number, max: number): number {
  const value = process.env[key];
  if (value === null || value === undefined) return defaultValue;
  const trimmed = value.trim();
  if (!trimmed) return defaultValue;
  const num = Number(trimmed);
  if (isNaN(num) || !isFinite(num)) {
    diag.warn(`DI: Invalid value '${trimmed}' for ${key}. Using default ${defaultValue}.`);
    return defaultValue;
  }
  const clamped = Math.max(min, Math.min(max, Math.floor(num)));
  if (clamped !== Math.floor(num)) {
    diag.debug(`DI: Clamped ${key} from ${Math.floor(num)} to ${clamped} (range: ${min}-${max}).`);
  }
  return clamped;
}

/**
 * Extract service.name from OTEL_RESOURCE_ATTRIBUTES or OTEL_SERVICE_NAME.
 */
function resolveServiceName(): string {
  // First check OTEL_SERVICE_NAME (takes precedence per OTel spec)
  const serviceName = process.env.OTEL_SERVICE_NAME;
  if (serviceName && serviceName.trim()) {
    return serviceName.trim();
  }

  // Fall back to OTEL_RESOURCE_ATTRIBUTES
  const envResources = process.env.OTEL_RESOURCE_ATTRIBUTES ?? '';
  for (const pair of envResources.split(',')) {
    if (pair.includes('=')) {
      const [key, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (key.trim() === 'service.name') {
        return value.trim();
      }
    }
  }

  return 'unknown_service';
}

/**
 * Extract deployment.environment.name from OTEL_RESOURCE_ATTRIBUTES.
 */
function resolveEnvironment(): string {
  const envResources = process.env.OTEL_RESOURCE_ATTRIBUTES ?? '';
  for (const pair of envResources.split(',')) {
    if (pair.includes('=')) {
      const [key, ...rest] = pair.split('=');
      const value = rest.join('=');
      const trimmedKey = key.trim();
      if (trimmedKey === 'deployment.environment.name') {
        return value.trim();
      }
      if (trimmedKey === 'deployment.environment') {
        return value.trim();
      }
    }
  }
  return '';
}

/**
 * Create DI config from environment variables.
 */
export function createDynamicInstrumentationConfig(): DynamicInstrumentationConfig {
  return {
    enabled: getEnvBool('OTEL_AWS_DYNAMIC_INSTRUMENTATION_ENABLED', DEFAULTS.enabled),
    apiUrl: getEnvStr('OTEL_AWS_DYNAMIC_INSTRUMENTATION_API_URL', DEFAULTS.apiUrl),
    probePollIntervalSeconds: getEnvInt(
      'OTEL_AWS_DYNAMIC_INSTRUMENTATION_PROBE_POLL_INTERVAL',
      DEFAULTS.probePollIntervalSeconds,
      POLL_INTERVAL_RANGE.min,
      POLL_INTERVAL_RANGE.max
    ),
    breakpointPollIntervalSeconds: getEnvInt(
      'OTEL_AWS_DYNAMIC_INSTRUMENTATION_BREAKPOINT_POLL_INTERVAL',
      DEFAULTS.breakpointPollIntervalSeconds,
      POLL_INTERVAL_RANGE.min,
      POLL_INTERVAL_RANGE.max
    ),
    outputDirectory: getEnvStr('OTEL_AWS_DYNAMIC_INSTRUMENTATION_OUTPUT_DIRECTORY', DEFAULTS.outputDirectory),
    logsEndpoint: getEnvStr('OTEL_AWS_OTLP_LOGS_ENDPOINT', 'http://localhost:4316/v1/logs'),
    serviceName: resolveServiceName(),
    environment: resolveEnvironment(),
    resourceAttributes: {},
  };
}
