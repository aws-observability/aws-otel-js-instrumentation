// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Data models for endpoint telemetry.
 *
 * Defines structured schemas for EndpointMetricEvent that captures
 * aggregated HTTP endpoint metrics including error breakdown and duration histograms.
 */

import { DurationMetrics, MetricsStatsEntry } from './function-telemetry';
import { ResourceAttributes } from './resource-attributes';

/**
 * Single error detail with type and origin function.
 * Links an error type to the specific function where it originated.
 */
export interface ErrorDetail {
  error_type: string; // Exception class name (e.g., "TypeError", "TimeoutError")
  function_name: string; // Composite function name where error originated
}

/**
 * Error breakdown entry grouping errors by HTTP status code.
 *
 * Represents a specific error pattern (error type + function + status code)
 * and how many times it occurred during the aggregation period.
 *
 * Note: Each entry contains ONE primary error (not all errors from call path)
 * to avoid noise in telemetry data.
 */
export interface ErrorBreakdownEntry {
  errors: ErrorDetail[]; // List with single error (primary/last error only)
  count: number; // Number of occurrences of this error pattern
  failure_type: string; // HTTP status code as string (e.g., "500", "404")
}

/**
 * Incident exemplar linking an endpoint to a specific incident snapshot.
 */
export interface IncidentExemplar {
  snapshot_id: string;
  trigger_type: string;
  severity: string;
  timestamp: number;
}

/**
 * Endpoint metric telemetry event.
 *
 * Represents aggregated metrics for an HTTP endpoint over a collection period.
 */
export interface EndpointMetricEventData {
  // Metadata
  environment?: string;
  service_name: string;
  sdk_version: string;
  sdk_lang: string;
  instance_id: string;

  // Endpoint identification
  method: string;
  route: string;
  operation: string;

  // Process and timing
  pid: number;
  timestamp: string;

  // Core metrics
  count: number;
  faults: number;
  errors: number;

  // Type
  telemetry_type: string;

  // Error breakdown
  error_breakdown: ErrorBreakdownEntry[];

  // Incident tracking
  incident_count: number;
  incidents_exemplar: IncidentExemplar[];

  // Duration histogram
  duration: DurationMetrics | null;

  // Metrics stats
  MetricsStats: MetricsStatsEntry[] | null;

  // Resource attributes
  resource_attributes: ResourceAttributes | null;

  // Deployment context
  git_commit_sha?: string;
  deployment_id?: string;
}

export class EndpointMetricEvent implements EndpointMetricEventData {
  environment?: string;
  service_name: string;
  sdk_version: string;
  sdk_lang: string;
  instance_id: string;
  method: string;
  route: string;
  operation: string;
  pid: number;
  timestamp: string;
  count: number;
  faults: number;
  errors: number;
  telemetry_type: string;
  error_breakdown: ErrorBreakdownEntry[];
  incident_count: number;
  incidents_exemplar: IncidentExemplar[];
  duration: DurationMetrics | null;
  MetricsStats: MetricsStatsEntry[] | null;
  resource_attributes: ResourceAttributes | null;
  git_commit_sha?: string;
  deployment_id?: string;

  constructor(params: {
    environment?: string;
    service_name: string;
    sdk_version: string;
    instance_id: string;
    method: string;
    route: string;
    operation: string;
    pid: number;
    timestamp: string;
    count: number;
    faults?: number;
    errors?: number;
    telemetry_type?: string;
    error_breakdown?: ErrorBreakdownEntry[];
    incident_count?: number;
    incidents_exemplar?: IncidentExemplar[];
    duration?: DurationMetrics | null;
    MetricsStats?: MetricsStatsEntry[] | null;
    resource_attributes?: ResourceAttributes | null;
    git_commit_sha?: string;
    deployment_id?: string;
  }) {
    this.environment = params.environment;
    this.service_name = params.service_name;
    this.sdk_version = params.sdk_version;
    this.sdk_lang = 'nodejs';
    this.instance_id = params.instance_id;
    this.method = params.method;
    this.route = params.route;
    this.operation = params.operation;
    this.pid = params.pid;
    this.timestamp = params.timestamp;
    this.count = params.count;
    this.faults = params.faults ?? 0;
    this.errors = params.errors ?? 0;
    this.telemetry_type = params.telemetry_type ?? 'EndpointSummary';
    this.error_breakdown = params.error_breakdown ?? [];
    this.incident_count = params.incident_count ?? 0;
    this.incidents_exemplar = params.incidents_exemplar ?? [];
    this.duration = params.duration ?? null;
    this.MetricsStats = params.MetricsStats ?? null;
    this.resource_attributes = params.resource_attributes ?? null;
    this.git_commit_sha = params.git_commit_sha;
    this.deployment_id = params.deployment_id;
  }

  /**
   * Convert to dictionary for JSON serialization.
   * Sparse: omits zero/null/empty fields.
   */
  toDict(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      telemetry_type: this.telemetry_type,
      service_name: this.service_name,
      sdk_version: this.sdk_version,
      sdk_lang: this.sdk_lang,
      instance_id: this.instance_id,
      method: this.method,
      route: this.route,
      operation: this.operation,
      pid: this.pid,
      timestamp: this.timestamp,
      count: this.count,
      error_breakdown: this.error_breakdown,
    };

    // Omit environment entirely when unset (no "UnknownEnvironment" sentinel).
    if (this.environment) {
      result.environment = this.environment;
    }

    if (this.faults > 0) {
      result.faults = this.faults;
    }
    if (this.errors > 0) {
      result.errors = this.errors;
    }
    if (this.incident_count > 0) {
      result.incident_count = this.incident_count;
    }
    if (this.incidents_exemplar.length > 0) {
      result.incidents_exemplar = this.incidents_exemplar;
    }
    if (this.duration !== null) {
      result.duration = this.duration;
    }
    if (this.MetricsStats !== null) {
      result.MetricsStats = this.MetricsStats;
    }
    if (this.resource_attributes && !this.resource_attributes.isEmpty()) {
      result.resource_attributes = this.resource_attributes.toDict();
    }
    if (this.git_commit_sha) {
      result.git_commit_sha = this.git_commit_sha;
    }
    if (this.deployment_id) {
      result.deployment_id = this.deployment_id;
    }

    return result;
  }

  /**
   * Convert to EMF-compliant dictionary.
   * Duration keys are capitalized per EMF spec.
   */
  toEmfDict(): Record<string, unknown> {
    const result = this.toDict();

    // Convert duration fields to match EMF naming (capitalized keys)
    if (result.duration && typeof result.duration === 'object') {
      const dur = result.duration as DurationMetrics;
      result.duration = {
        Values: dur.values,
        Counts: dur.counts,
        Max: dur.max,
        Min: dur.min,
        Count: dur.count,
        Sum: dur.sum,
      };
    }

    return result;
  }

  /**
   * Generate EndpointErrorMetric instances from error_breakdown.
   * One per error type. Empty list if no errors.
   */
  toErrorTypeMetrics(): EndpointErrorMetric[] {
    const results: EndpointErrorMetric[] = [];
    // Deduplicate by exception type so we emit ONE metric per (operation, exception),
    // summing counts across different function_name origins.
    const byException = new Map<string, number>();
    for (const entry of this.error_breakdown) {
      for (const errorDetail of entry.errors) {
        const prev = byException.get(errorDetail.error_type) ?? 0;
        byException.set(errorDetail.error_type, prev + entry.count);
      }
    }
    for (const [exceptionType, count] of byException) {
      results.push(
        new EndpointErrorMetric({
          environment: this.environment,
          service_name: this.service_name,
          operation: this.operation,
          instance_id: this.instance_id,
          pid: this.pid,
          exception: exceptionType,
          count,
        })
      );
    }
    return results;
  }
}

/**
 * Per-error-type CloudWatch EMF metric event.
 */
export class EndpointErrorMetric {
  environment?: string;
  service_name: string;
  operation: string;
  instance_id: string;
  pid: number;
  exception: string;
  count: number;
  telemetry_type: string;
  sdk_lang: string;

  constructor(params: {
    environment?: string;
    service_name: string;
    operation: string;
    instance_id: string;
    pid: number;
    exception: string;
    count: number;
  }) {
    this.environment = params.environment;
    this.service_name = params.service_name;
    this.operation = params.operation;
    this.instance_id = params.instance_id;
    this.pid = params.pid;
    this.exception = params.exception;
    this.count = params.count;
    this.telemetry_type = 'EndpointErrorMetric';
    this.sdk_lang = 'nodejs';
  }

  toEmfDict(): Record<string, unknown> {
    // Omit environment (field + dimension) entirely when unset — no
    // "UnknownEnvironment" sentinel. CloudWatch EMF requires every dimension
    // key to have a present field value, so drop it from the Dimensions array
    // in lockstep when there's no environment.
    const dimensions = this.environment
      ? ['environment', 'service_name', 'operation', 'exception']
      : ['service_name', 'operation', 'exception'];

    const result: Record<string, unknown> = {
      telemetry_type: this.telemetry_type,
      sdk_lang: this.sdk_lang,
      service_name: this.service_name,
      operation: this.operation,
      instance_id: this.instance_id,
      pid: this.pid,
      exception: this.exception,
      count: this.count,
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: 'ServiceEvents',
            Dimensions: [dimensions],
            Metrics: [{ Name: 'count', Unit: 'Count' }],
          },
        ],
        Timestamp: Date.now(),
      },
    };
    if (this.environment) {
      result.environment = this.environment;
    }
    return result;
  }
}
