// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Data models for function call telemetry using CloudWatch EMF format.
 *
 * Defines structured schemas for FunctionCall events that use CloudWatch EMF
 * (Embedded Metric Format) for metrics export.
 */

import { ResourceAttributes } from './resource-attributes';

/**
 * Definition of a single metric.
 * Part of the EMF (Embedded Metric Format) structure.
 */
export interface MetricDefinition {
  Name: string;
  Unit: string;
}

/**
 * Metric stats entry with dimensions and metrics.
 * Part of the EMF (Embedded Metric Format) structure.
 */
export interface MetricsStatsEntry {
  Dimensions: string[][];
  Metrics: MetricDefinition[];
}

// Backward-compatible aliases
export type CloudWatchMetricDefinition = MetricDefinition;
export type CloudWatchMetricSet = MetricsStatsEntry & { Namespace: string };
export interface CloudWatchMetadata {
  CloudWatchMetrics: CloudWatchMetricSet[];
  Timestamp: number;
}

/**
 * Duration metrics in EMF histogram format.
 *
 * Represents aggregated duration measurements for multiple function calls.
 * Uses CloudWatch EMF histogram format with Values and Counts arrays.
 *
 * Note: Values and Counts can be floats due to SEH (Sparse Exponential Histogram)
 * aggregation which may produce float bucket midpoints and weighted counts.
 */
export interface DurationMetrics {
  values: number[]; // Bucket midpoints or duration samples (microseconds)
  counts: number[]; // Count for each value (can be weighted floats from SEH)
  max: number; // Maximum duration (microseconds)
  min: number; // Minimum duration (microseconds)
  count: number; // Total number of invocations
  sum: number; // Sum of all durations (microseconds)
}

/**
 * Function call telemetry event using CloudWatch EMF format.
 *
 * This schema represents aggregated metrics for a function over a collection period.
 */
export interface FunctionCallMetricsData {
  // Metadata
  environment?: string;
  service_name: string;
  sdk_version: string;
  sdk_lang: string;
  instance_id: string;

  // Function identification
  function_name: string;
  function_at_line?: number;

  // Process and timing
  pid: number;
  timestamp: string;

  // Format
  version: string;
  telemetry_type: string;

  // Optional
  operation: string | null;
  caller: string | null;

  // Async tracking
  is_async: boolean;

  // Error tracking
  exceptions: Record<string, number>;

  // Core telemetry
  duration: DurationMetrics | null;
  MetricsStats: MetricsStatsEntry[] | null;

  // Resource attributes
  resource_attributes: ResourceAttributes | null;

  // Deployment context
  git_commit_sha?: string;
  deployment_id?: string;
}

export class FunctionCallMetrics implements FunctionCallMetricsData {
  environment?: string;
  service_name: string;
  sdk_version: string;
  sdk_lang: string;
  git_commit_sha?: string;
  deployment_id?: string;
  instance_id: string;
  function_name: string;
  function_at_line?: number;
  pid: number;
  timestamp: string;
  version: string;
  telemetry_type: string;
  operation: string | null;
  caller: string | null;
  is_async: boolean;
  exceptions: Record<string, number>;
  duration: DurationMetrics | null;
  MetricsStats: MetricsStatsEntry[] | null;
  resource_attributes: ResourceAttributes | null;

  constructor(params: {
    environment?: string;
    service_name: string;
    sdk_version: string;
    instance_id: string;
    function_name: string;
    function_at_line?: number;
    pid: number;
    timestamp: string;
    version?: string;
    telemetry_type?: string;
    operation?: string | null;
    caller?: string | null;
    is_async?: boolean;
    exceptions?: Record<string, number>;
    duration?: DurationMetrics | null;
    MetricsStats?: MetricsStatsEntry[] | null;
    resource_attributes?: ResourceAttributes | null;
    git_commit_sha?: string;
    deployment_id?: string;
    // Backward-compat: accept _aws but ignore it
    _aws?: CloudWatchMetadata | null;
  }) {
    this.environment = params.environment;
    this.service_name = params.service_name;
    this.sdk_version = params.sdk_version;
    this.sdk_lang = 'nodejs';
    this.instance_id = params.instance_id;
    this.function_name = params.function_name;
    this.function_at_line = params.function_at_line;
    this.pid = params.pid;
    this.timestamp = params.timestamp;
    this.version = params.version ?? '1';
    this.telemetry_type = params.telemetry_type ?? 'FunctionCall';
    this.operation = params.operation ?? null;
    this.caller = params.caller ?? null;
    this.is_async = params.is_async ?? false;
    this.exceptions = params.exceptions ?? {};
    this.duration = params.duration ?? null;
    this.MetricsStats = params.MetricsStats ?? null;
    this.resource_attributes = params.resource_attributes ?? null;
    this.git_commit_sha = params.git_commit_sha;
    this.deployment_id = params.deployment_id;
  }

  /**
   * Convert to dictionary for JSON serialization.
   */
  toDict(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      version: this.version,
      telemetry_type: this.telemetry_type,
      service_name: this.service_name,
      sdk_version: this.sdk_version,
      sdk_lang: this.sdk_lang,
      instance_id: this.instance_id,
      function_name: this.function_name,
      pid: this.pid,
      timestamp: this.timestamp,
      operation: this.operation,
      caller: this.caller,
      is_async: this.is_async,
      exceptions: this.exceptions,
      duration: this.duration,
      MetricsStats: this.MetricsStats,
    };
    // Omit environment entirely when unset (no "UnknownEnvironment" sentinel).
    if (this.environment) {
      result.environment = this.environment;
    }
    if (this.function_at_line !== undefined) {
      result.function_at_line = this.function_at_line;
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
   *
   * Ensures proper field naming and structure for CloudWatch EMF format.
   * Duration keys are capitalized per EMF spec (Values, Counts, Max, Min, Count, Sum).
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
}
