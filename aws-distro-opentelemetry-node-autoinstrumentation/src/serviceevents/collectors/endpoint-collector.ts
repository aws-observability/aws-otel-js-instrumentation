// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * EndpointMetricCollector - Collects and exports HTTP endpoint metrics.
 */

import { diag } from '@opentelemetry/api';
import { BaseCollector } from './base-collector';
import { EndpointMetricEvent, ErrorBreakdownEntry, IncidentExemplar } from '../models/endpoint-telemetry';
import { DurationMetrics, MetricsStatsEntry } from '../models/function-telemetry';
import { ResourceAttributes } from '../models/resource-attributes';
import { getInstanceId } from '../utils/instance-id';
import { SEHHistogram } from '../utils/seh-histogram';
import { ServiceEventsOtlpEmitter } from '../exporter/otlp-emitter';

interface ErrorData {
  errorType: string;
  functionName: string;
  count: number;
}

interface EndpointAggregation {
  route: string;
  method: string;
  count: number;
  faults: number; // 5xx count
  errors: number; // 4xx count
  sehHistogram: SEHHistogram;
  sumDuration: number; // nanoseconds
  errorBreakdown: Map<string, Map<string, ErrorData>>; // failureType -> errorKey -> data
  incidentsExemplar: IncidentExemplar[];
}

/**
 * Maximum error breakdown entries emitted per endpoint per flush window.
 * Matches Java EndpointCollector.MAX_EXCEPTION_METRICS = 5: sort by count
 * descending and take the top N. The map is still unbounded during collection
 * (parity with Python) but the emitted payload is always bounded.
 */
const MAX_EXCEPTION_METRICS = 5;

export class EndpointMetricCollector extends BaseCollector {
  private environment?: string;
  private serviceName: string;
  private sdkVersion: string;
  private gitCommitSha: string | undefined;
  private deploymentId: string | undefined;
  private pid: number;
  private resourceAttributes: ResourceAttributes | null;
  private otlpEmitter: ServiceEventsOtlpEmitter | null;
  private suppressEndpointSummary: boolean;
  /** Aggregations keyed by operation string ("METHOD /route"). */
  private _aggregations: Map<string, EndpointAggregation> = new Map();

  constructor(
    flushIntervalMs: number,
    environment?: string,
    serviceName?: string,
    sdkVersion: string = '0.0.0',
    otlpEmitter: ServiceEventsOtlpEmitter | null = null,
    resourceAttributes?: ResourceAttributes | null,
    suppressEndpointSummary: boolean = false
  ) {
    super(flushIntervalMs, 'EndpointMetricCollector');
    this.environment = environment;
    this.serviceName = serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'UnknownService';
    this.sdkVersion = sdkVersion;
    this.gitCommitSha = process.env.OTEL_AWS_SERVICE_EVENTS_GIT_COMMIT_SHA;
    this.deploymentId = process.env.OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_ID;
    this.pid = process.pid;
    this.resourceAttributes = resourceAttributes ?? null;
    this.otlpEmitter = otlpEmitter;
    this.suppressEndpointSummary = suppressEndpointSummary;
  }

  /**
   * Confirm an operation has been recorded (returns the operation itself when known,
   * null otherwise). Used by FunctionCallCollector to drop callsites that never
   * matched an observed endpoint.
   */
  lookupOperation(operation: string | null): string | null {
    if (!operation) return null;
    return this._aggregations.has(operation) ? operation : null;
  }

  /**
   * Record an HTTP request with optional error information.
   */
  recordRequest(
    route: string,
    method: string,
    statusCode: number,
    durationNs: number,
    errorInfo?: { errorType: string; functionName: string }
  ): void {
    const operation = `${method} ${route}`;

    let agg = this._aggregations.get(operation);
    if (!agg) {
      agg = {
        route,
        method,
        count: 0,
        faults: 0,
        errors: 0,
        sehHistogram: new SEHHistogram(100),
        sumDuration: 0,
        errorBreakdown: new Map(),
        incidentsExemplar: [],
      };
      this._aggregations.set(operation, agg);
    }

    agg.count += 1;

    // Track faults (5xx) and errors (4xx)
    if (statusCode >= 500) {
      agg.faults += 1;
    } else if (statusCode >= 400) {
      agg.errors += 1;
    }

    // Record duration in SEH histogram
    if (durationNs > 0) {
      agg.sehHistogram.recordUnsafe(durationNs);
      agg.sumDuration += durationNs;
    }

    // Track error breakdown if error occurred
    if (statusCode >= 400 && errorInfo) {
      const failureType = String(statusCode);
      const errorKey = `${errorInfo.errorType}:${errorInfo.functionName}`;

      let failureMap = agg.errorBreakdown.get(failureType);
      if (!failureMap) {
        failureMap = new Map();
        agg.errorBreakdown.set(failureType, failureMap);
      }

      let errorData = failureMap.get(errorKey);
      if (!errorData) {
        errorData = {
          errorType: errorInfo.errorType,
          functionName: errorInfo.functionName,
          count: 0,
        };
        failureMap.set(errorKey, errorData);
      }

      errorData.count += 1;
    }
  }

  /**
   * Record an incident exemplar for an endpoint.
   */
  recordIncidentExemplar(operation: string, exemplar: IncidentExemplar): void {
    const agg = this._aggregations.get(operation);
    if (agg) {
      agg.incidentsExemplar.push(exemplar);
    }
  }

  collect(): void {
    // Atomic swap
    const aggregations = this._aggregations;
    this._aggregations = new Map();

    if (aggregations.size === 0) {
      diag.debug('No endpoint metrics to export');
      return;
    }

    const events = this.formatEndpointMetrics(aggregations);

    if (events.length > 0 && this.otlpEmitter) {
      for (const event of events) {
        // Suppress EndpointSummary when Application Signals is enabled —
        // App Signals emits equivalent per-endpoint duration + error metrics,
        // so emitting both would duplicate data on the backend. Error metrics
        // (EndpointErrorMetric) carry ServiceEvents-specific per-exception-type
        // breakdown that App Signals doesn't, so those still emit.
        if (!this.suppressEndpointSummary) {
          this.otlpEmitter.emitEndpointSummary(event);
        }
        for (const errorMetric of event.toErrorTypeMetrics()) {
          this.otlpEmitter.emitEndpointErrorMetric(errorMetric);
        }
      }
      if (!this.suppressEndpointSummary) {
        diag.info(`Emitted ${events.length} EndpointSummary log records via OTLP`);
      }
    }
  }

  private formatEndpointMetrics(aggregations: Map<string, EndpointAggregation>): EndpointMetricEvent[] {
    const events: EndpointMetricEvent[] = [];
    const timestamp = new Date().toISOString();
    const instanceId = this.resourceAttributes?.host_id || getInstanceId();

    for (const [operation, agg] of aggregations) {
      if (agg.count === 0) {
        continue;
      }

      // Convert error breakdown to list of ErrorBreakdownEntry, then truncate to
      // top MAX_EXCEPTION_METRICS by count (mirrors Java EndpointCollector:
      // MAX_EXCEPTION_METRICS = 5, sort by count desc, take top N).
      const errorBreakdownList: ErrorBreakdownEntry[] = [];
      for (const [failureType, errorMap] of agg.errorBreakdown) {
        for (const [, errorData] of errorMap) {
          if (errorData.count > 0) {
            errorBreakdownList.push({
              errors: [{ error_type: errorData.errorType, function_name: errorData.functionName }],
              count: errorData.count,
              failure_type: failureType,
            });
          }
        }
      }
      errorBreakdownList.sort((a, b) => b.count - a.count);
      const truncatedBreakdown = errorBreakdownList.slice(0, MAX_EXCEPTION_METRICS);

      // Convert SEH histogram to DurationMetrics
      const durationMetrics = this.convertToEmfHistogram(agg.sehHistogram, agg.sumDuration, agg.count);

      // Build MetricsStats. Drop the 'environment' dimension when unset so the
      // EMF dimension set matches the emitted fields (no sentinel).
      const dimensions = this.environment
        ? ['environment', 'service_name', 'operation']
        : ['service_name', 'operation'];
      const metricsStats: MetricsStatsEntry[] = [
        {
          Dimensions: [dimensions],
          Metrics: [
            {
              Name: 'duration',
              Unit: 'Microseconds',
            },
          ],
        },
      ];

      const event = new EndpointMetricEvent({
        environment: this.environment,
        service_name: this.serviceName,
        sdk_version: this.sdkVersion,
        instance_id: instanceId,
        method: agg.method,
        route: agg.route,
        operation,
        pid: this.pid,
        timestamp,
        count: agg.count,
        faults: agg.faults,
        errors: agg.errors,
        error_breakdown: truncatedBreakdown,
        incident_count: agg.incidentsExemplar.length,
        incidents_exemplar: agg.incidentsExemplar,
        duration: durationMetrics,
        MetricsStats: metricsStats,
        resource_attributes: this.resourceAttributes,
        git_commit_sha: this.gitCommitSha,
        deployment_id: this.deploymentId,
      });

      events.push(event);
    }

    return events;
  }

  private convertToEmfHistogram(sehHistogram: SEHHistogram, sumDuration: number, count: number): DurationMetrics {
    if (sehHistogram.isEmpty()) {
      return {
        values: [],
        counts: [],
        max: 0,
        min: 0,
        count: 0,
        sum: 0,
      };
    }

    // Get aggregated buckets from SEH histogram
    const [values, counts] = sehHistogram.getValuesAndCounts();
    const stats = sehHistogram.getStatistics();

    // Convert from nanoseconds to microseconds
    const valuesUs = values.map(v => v / 1000.0);
    const maxUs = stats.max / 1000.0;
    const minUs = stats.min / 1000.0;
    const sumUs = sumDuration / 1000.0;

    return {
      values: valuesUs,
      counts: counts,
      max: maxUs,
      min: minUs,
      count: count,
      sum: sumUs,
    };
  }
}
