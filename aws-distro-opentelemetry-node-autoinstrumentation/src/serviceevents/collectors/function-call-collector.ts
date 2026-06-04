// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * FunctionCallCollector - Periodically collects and exports function call metrics in EMF format.
 */

import { diag } from '@opentelemetry/api';
import { BaseCollector } from './base-collector';
import { ServiceEventsMonitorState, Aggregations } from '../serviceevents-monitor';
import { FunctionCallMetrics, DurationMetrics, MetricsStatsEntry } from '../models/function-telemetry';
import { ResourceAttributes } from '../models/resource-attributes';
import { getInstanceId } from '../utils/instance-id';
import { SEHHistogram } from '../utils/seh-histogram';
import { getFunctionInfo } from '../ast-transformation';
import { ServiceEventsOtlpEmitter } from '../exporter/otlp-emitter';

export class FunctionCallCollector extends BaseCollector {
  private monitorState: ServiceEventsMonitorState;
  private environment?: string;
  private serviceName: string;
  private sdkVersion: string;
  private gitCommitSha: string | undefined;
  private deploymentId: string | undefined;
  private pid: number;
  private resourceAttributes: ResourceAttributes | null;
  private otlpEmitter: ServiceEventsOtlpEmitter | null;
  private operationLookup: ((operation: string | null) => string | null) | null = null;

  constructor(
    flushIntervalMs: number,
    environment?: string,
    serviceName?: string,
    sdkVersion: string = '0.0.0',
    otlpEmitter: ServiceEventsOtlpEmitter | null = null,
    resourceAttributes?: ResourceAttributes | null
  ) {
    super(flushIntervalMs, 'FunctionCallCollector');
    this.monitorState = ServiceEventsMonitorState.getInstance();
    this.environment = environment;
    this.serviceName = serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'UnknownService';
    this.sdkVersion = sdkVersion;
    this.gitCommitSha = process.env.OTEL_AWS_SERVICE_EVENTS_GIT_COMMIT_SHA;
    this.deploymentId = process.env.OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_ID;
    this.pid = process.pid;
    this.resourceAttributes = resourceAttributes ?? null;
    this.otlpEmitter = otlpEmitter;
  }

  /**
   * Set a callback that confirms an operation string has been observed by the
   * endpoint collector. Returns the same operation string or null.
   */
  setOperationLookup(lookup: (operation: string | null) => string | null): void {
    this.operationLookup = lookup;
  }

  collect(): void {
    // When the OTel `service.function.duration` histogram is wired, it becomes
    // the sole function-call signal — SEH/EMF aggregation is skipped in
    // `__serviceeventsMonitorExit`, and this collector flushes as a no-op so
    // we don't emit `aws.service_events.function_call` LogRecords synthesized
    // from raw _callCounts deltas with no duration data attached.
    if (this.monitorState.hasFunctionDurationHistogram()) {
      // Drain so deltas don't accumulate unbounded across no-op flushes.
      this.monitorState.getAndSwapAggregations();
      this.monitorState.getCallCountDeltas();
      return;
    }

    // Get sampled aggregations AND total inline call count deltas
    const aggregations = this.monitorState.getAndSwapAggregations();
    const totalCountDeltas = this.monitorState.getCallCountDeltas();

    // Enrich sampled aggregation buckets with total call counts.
    for (const [funcName, totalDelta] of Object.entries(totalCountDeltas)) {
      if (totalDelta <= 0) continue;
      const endpointMap = aggregations.get(funcName);
      if (endpointMap) {
        let largestBucket = null;
        let largestCount = -1;
        for (const bucket of endpointMap.values()) {
          if (bucket.count > largestCount) {
            largestCount = bucket.count;
            largestBucket = bucket;
          }
        }
        if (largestBucket) {
          largestBucket.count = totalDelta;
        }
      } else {
        const newMap = new Map();
        newMap.set(null, {
          count: totalDelta,
          sampledCount: 0,
          sumDuration: 0,
          sumSquaredDuration: 0,
          exceptions: new Map(),
          callerMap: new Map(),
          sehHistogram: new SEHHistogram(100),
        });
        aggregations.set(funcName, newMap);
      }
    }

    if (aggregations.size === 0) {
      // Either no function call captured or functions are recorded through
      // histogram metrics directly in __serviceeventsMonitorExit (service.function.duration).
      diag.debug('No function call data to export');
      return;
    }

    // Format and emit each function's metrics via OTLP
    const events = this.formatFunctionCalls(aggregations);

    if (events.length > 0 && this.otlpEmitter) {
      for (const event of events) {
        this.otlpEmitter.emitFunctionCall(event);
      }
      diag.info(`Emitted ${events.length} FunctionCall log records via OTLP`);
    }
  }

  private formatFunctionCalls(aggregations: Aggregations): FunctionCallMetrics[] {
    const events: FunctionCallMetrics[] = [];
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const instanceId = this.resourceAttributes?.host_id || getInstanceId();

    for (const [functionName, operationMap] of aggregations) {
      for (const [opKey, agg] of operationMap) {
        if (agg.sampledCount === 0) {
          continue;
        }

        // Get most common caller
        let caller: string | null = null;
        if (agg.callerMap.size > 0) {
          let maxCount = 0;
          for (const [callerName, count] of agg.callerMap) {
            if (count > maxCount) {
              maxCount = count;
              caller = callerName;
            }
          }
        }

        // Look up isAsync + line from function registry
        const funcInfo = getFunctionInfo(functionName);
        const isAsync = funcInfo?.isAsync ?? false;
        const functionAtLine = funcInfo?.line;

        // Filter out operations the endpoint collector never saw (stale/unknown).
        let operation: string | null = opKey;
        if (this.operationLookup) {
          operation = this.operationLookup(opKey);
        }

        // Convert SEH histogram to EMF format
        const durationMetrics = this.convertToEmfHistogram(agg.sehHistogram, agg.sumDuration, agg.count);

        // Convert exceptions Map to plain object
        const exceptions: Record<string, number> = {};
        for (const [key, val] of agg.exceptions) {
          exceptions[key] = val;
        }

        // Create MetricsStats. Drop the 'environment' dimension when unset so
        // the EMF dimension set matches the emitted fields (no sentinel).
        const dimensions = this.environment
          ? ['environment', 'service_name', 'function_name', 'operation']
          : ['service_name', 'function_name', 'operation'];
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

        // Create FunctionCallMetrics object
        const event = new FunctionCallMetrics({
          environment: this.environment,
          service_name: this.serviceName,
          sdk_version: this.sdkVersion,
          instance_id: instanceId,
          function_name: functionName,
          function_at_line: functionAtLine,
          operation,
          caller,
          is_async: isAsync,
          pid: this.pid,
          timestamp,
          exceptions,
          duration: durationMetrics,
          MetricsStats: metricsStats,
          resource_attributes: this.resourceAttributes,
          git_commit_sha: this.gitCommitSha,
          deployment_id: this.deploymentId,
        });

        events.push(event);
      }
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
