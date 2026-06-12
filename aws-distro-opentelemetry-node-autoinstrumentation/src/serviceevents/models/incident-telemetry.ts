// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Data models for incident snapshot telemetry.
 *
 * Defines structured schemas for IncidentSnapshot events that capture
 * comprehensive context when errors, timeouts, or anomalies occur.
 * Uses custom JSON format (not CloudWatch EMF).
 */

import { ResourceAttributes } from './resource-attributes';

/**
 * Single function call in the execution path.
 *
 * Captures timing and caller information for each function invocation
 * during request processing.
 */
export interface CallPathEntry {
  function_name: string;
  caller_function_name: string;
  duration_ns: number;
  error: boolean;
  is_async?: boolean;
  function_at_line?: number;
}

/**
 * Exception details with full call path.
 *
 * Captures exception type, message, stack trace, and the sequence of
 * function calls that led to the exception.
 */
export interface ExceptionInfo {
  exception_type: string;
  exception_message: string;
  stack_trace: string;
  call_path: CallPathEntry[];
}

/**
 * HTTP request context information.
 *
 * Captures details about the HTTP request that triggered the incident,
 * including custom business context and request payload data.
 */
export interface RequestContext {
  type: string;
  timestamp: number; // Milliseconds since epoch
  status_code: number;
  custom_context: Record<string, unknown>;
  request_body?: unknown;
  query_params?: Record<string, unknown>;
  path_params?: Record<string, unknown>;
  request_headers?: Record<string, string>;
}

/**
 * APM trace and business correlation identifiers.
 *
 * Links incidents to distributed traces for cross-system correlation.
 */
export interface TelemetryCorrelation {
  trace_id?: string;
  span_id?: string;
  correlation_ids: Record<string, string>;
}

/**
 * Incident snapshot telemetry event.
 *
 * Captures comprehensive context when errors, timeouts, or anomalies occur.
 * Includes execution flow, exception details, request context, and correlation IDs.
 */
export interface IncidentSnapshotData {
  snapshot_id: string;
  timestamp: number; // Milliseconds since epoch
  severity: string;
  trigger_type: string; // "exception", "latency"
  service: string;
  environment?: string;
  instance_id: string;
  affected_endpoint: string;
  sdk_version: string;
  sdk_lang: string;
  pid: number;
  duration_ms: number;
  is_partial: boolean;
  exception_info: ExceptionInfo[];
  request_context: RequestContext;
  telemetry_correlation: TelemetryCorrelation;
  telemetry_type: string;
  resource_attributes: ResourceAttributes | null;
  git_commit_sha?: string;
  deployment_id?: string;
}

export class IncidentSnapshot implements IncidentSnapshotData {
  snapshot_id: string;
  timestamp: number;
  severity: string;
  trigger_type: string;
  service: string;
  environment?: string;
  instance_id: string;
  affected_endpoint: string;
  sdk_version: string;
  sdk_lang: string;
  pid: number;
  duration_ms: number;
  is_partial: boolean;
  exception_info: ExceptionInfo[];
  request_context: RequestContext;
  telemetry_correlation: TelemetryCorrelation;
  telemetry_type: string;
  resource_attributes: ResourceAttributes | null;
  git_commit_sha?: string;
  deployment_id?: string;

  constructor(params: {
    snapshot_id: string;
    timestamp: number;
    severity: string;
    trigger_type: string;
    service: string;
    environment?: string;
    instance_id: string;
    affected_endpoint: string;
    sdk_version: string;
    pid: number;
    duration_ms: number;
    is_partial?: boolean;
    exception_info: ExceptionInfo[];
    request_context: RequestContext;
    telemetry_correlation: TelemetryCorrelation;
    telemetry_type?: string;
    resource_attributes?: ResourceAttributes | null;
    git_commit_sha?: string;
    deployment_id?: string;
  }) {
    this.snapshot_id = params.snapshot_id;
    this.timestamp = params.timestamp;
    this.severity = params.severity;
    this.trigger_type = params.trigger_type;
    this.service = params.service;
    this.environment = params.environment;
    this.instance_id = params.instance_id;
    this.affected_endpoint = params.affected_endpoint;
    this.sdk_version = params.sdk_version;
    this.sdk_lang = 'nodejs';
    this.pid = params.pid;
    this.duration_ms = params.duration_ms;
    this.is_partial = params.is_partial ?? false;
    this.exception_info = params.exception_info;
    this.request_context = params.request_context;
    this.telemetry_correlation = params.telemetry_correlation;
    this.telemetry_type = params.telemetry_type ?? 'IncidentSnapshot';
    this.resource_attributes = params.resource_attributes ?? null;
    this.git_commit_sha = params.git_commit_sha;
    this.deployment_id = params.deployment_id;
  }

  /**
   * Convert to dictionary for JSON serialization.
   */
  toDict(): Record<string, unknown> {
    // Process exception_info to handle is_async and is_partial in call_path
    const exceptionInfo = this.exception_info.map(ei => {
      const callPath = ei.call_path.map(cp => {
        const entry: Record<string, unknown> = {
          function_name: cp.function_name,
          caller_function_name: cp.caller_function_name,
          error: cp.error,
        };
        // Omit duration_ns when is_partial (no timing data)
        if (!this.is_partial) {
          entry.duration_ns = cp.duration_ns;
        }
        // Only include is_async when true
        if (cp.is_async) {
          entry.is_async = true;
        }
        if (cp.function_at_line !== undefined && !this.is_partial) {
          entry.function_at_line = cp.function_at_line;
        }
        return entry;
      });
      return {
        exception_type: ei.exception_type,
        exception_message: ei.exception_message,
        stack_trace: ei.stack_trace,
        call_path: callPath,
      };
    });

    const result: Record<string, unknown> = {
      telemetry_type: this.telemetry_type,
      snapshot_id: this.snapshot_id,
      timestamp: this.timestamp,
      severity: this.severity,
      trigger_type: this.trigger_type,
      service: this.service,
      instance_id: this.instance_id,
      affected_endpoint: this.affected_endpoint,
      sdk_version: this.sdk_version,
      sdk_lang: this.sdk_lang,
      pid: this.pid,
      duration_ms: this.duration_ms,
      is_partial: this.is_partial,
      exception_info: exceptionInfo,
      request_context: this.request_context,
      telemetry_correlation: this.telemetry_correlation,
    };

    // Omit environment entirely when unset (no "UnknownEnvironment" sentinel).
    if (this.environment) {
      result.environment = this.environment;
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
}
