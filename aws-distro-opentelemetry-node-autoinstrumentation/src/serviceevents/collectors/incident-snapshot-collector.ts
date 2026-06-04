// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * IncidentSnapshotCollector - Triggers and collects deep incident snapshots.
 *
 * Incident snapshots are triggered when:
 * - HTTP status code >= 500 (server errors)
 * - Request duration > threshold (slow requests)
 * - Unhandled exceptions occur
 *
 * Rate limiting and deduplication prevent snapshot spam.
 */

import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { diag, trace } from '@opentelemetry/api';
import { BaseCollector } from './base-collector';
import {
  ServiceEventsMonitorState,
  InvestigationData,
  markOperationHot,
  tickHotOperations,
} from '../serviceevents-monitor';
import {
  IncidentSnapshot,
  ExceptionInfo,
  CallPathEntry,
  RequestContext,
  TelemetryCorrelation,
} from '../models/incident-telemetry';
import { IncidentExemplar } from '../models/endpoint-telemetry';
import { ResourceAttributes } from '../models/resource-attributes';
import { getInstanceId } from '../utils/instance-id';
import { getFunctionInfo } from '../ast-transformation';
import { ServiceEventsOtlpEmitter } from '../exporter/otlp-emitter';
import { minimatch } from 'minimatch';
import { truncateString } from '../utils/data-sanitizer';

/**
 * Caps for incident-snapshot fields that can carry customer data / PII and flow
 * to CloudWatch Logs. Exception messages and stack traces are on the DEFAULT-ON
 * path (any 5xx / unhandled error produces them), so they are always truncated.
 */
const MAX_EXCEPTION_MESSAGE_CHARS = 2048;
const MAX_STACK_TRACE_CHARS = 8192;

export interface RequestData {
  headers?: Record<string, string>;
  args?: Record<string, string>;
  viewArgs?: Record<string, string>;
  cachedBody?: unknown;
  [key: string]: unknown;
}

export class IncidentSnapshotCollector extends BaseCollector {
  private durationThresholdMs: number;
  /**
   * Per-endpoint latency thresholds as [pattern, thresholdMs] tuples, where
   * pattern is a glob over the operation string "METHOD /route" (e.g.
   * "GET /api/*"). First match wins; endpoints with no match fall back to the
   * global durationThresholdMs. Sourced from OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS
   * via getLatencyThresholdPatterns(config). Empty by default.
   */
  private latencyThresholdPatterns: Array<[string, number]>;
  // Max snapshots per rate-limit window. The window is now fixed at 60s
  // (`periodSeconds`); only this ceiling is configurable. The field/setter
  // name `maxPerPeriod` is retained for stability even though the env var is
  // OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE.
  private maxPerPeriod: number;
  private periodSeconds: number;
  private environment?: string;
  private serviceName: string;
  private sdkVersion: string;
  private gitCommitSha: string | undefined;
  private deploymentId: string | undefined;
  private pid: number;
  private resourceAttributes: ResourceAttributes | null;
  private otlpEmitter: ServiceEventsOtlpEmitter | null;

  // Request payload capture settings — opt-in per spec §5
  private captureRequestBody: boolean;

  // Rate limiting
  private _snapshotTimestamps: number[] = [];
  private _maxSameError: number;

  // Deduplication
  private _errorHashes: Map<string, number[]> = new Map(); // hash -> [timestamp1, ...]
  private _currentBatchHashes: Set<string> = new Set(); // one snapshot per error type per collection interval

  // Pending snapshots
  private _pendingSnapshots: IncidentSnapshot[] = [];

  // Monitor state
  private _monitorState: ServiceEventsMonitorState;

  constructor(
    flushIntervalMs: number,
    durationThresholdMs: number,
    maxPerPeriod: number,
    environment?: string,
    serviceName?: string,
    sdkVersion: string = '0.0.0',
    captureRequestBody: boolean = false,
    maxSameError: number = 1,
    otlpEmitter: ServiceEventsOtlpEmitter | null = null,
    resourceAttributes?: ResourceAttributes | null,
    latencyThresholdPatterns: Array<[string, number]> = []
  ) {
    super(flushIntervalMs, 'IncidentSnapshotCollector');

    this.durationThresholdMs = durationThresholdMs;
    this.latencyThresholdPatterns = latencyThresholdPatterns;
    this.maxPerPeriod = maxPerPeriod;
    // Rate-limit window is fixed at 60s — no longer configurable via env.
    this.periodSeconds = 60;

    this.environment = environment;
    this.serviceName = serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'UnknownService';
    this.sdkVersion = sdkVersion;
    this.gitCommitSha = process.env.OTEL_AWS_SERVICE_EVENTS_GIT_COMMIT_SHA;
    this.deploymentId = process.env.OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_ID;
    this.pid = process.pid;
    this.resourceAttributes = resourceAttributes ?? null;
    this.otlpEmitter = otlpEmitter;

    this.captureRequestBody = captureRequestBody;
    this._maxSameError = maxSameError;

    this._monitorState = ServiceEventsMonitorState.getInstance();
  }

  /**
   * Update the max incidents per (now fixed 60s) window.
   * @deprecated No longer dynamically configurable — collectors are configured
   * once at startup from static env config. Retained as an unused public setter.
   */
  setMaxPerPeriod(n: number): void {
    if (n > 0) {
      this.maxPerPeriod = n;
    }
  }

  /**
   * Update the max same error dedup limit.
   * @deprecated No longer dynamically configurable — collectors are configured
   * once at startup from static env config. Retained as an unused public setter.
   */
  setMaxSameError(n: number): void {
    if (n > 0) {
      this._maxSameError = n;
    }
  }

  /**
   * Process a potential incident snapshot trigger.
   *
   * @returns IncidentExemplar if a snapshot was created, null otherwise.
   */
  processPotentialIncident(
    route: string,
    method: string,
    statusCode: number,
    durationMs: number,
    exception: Error | null,
    requestData: RequestData
  ): IncidentExemplar | null {
    // Check if snapshot should be triggered (uses per-endpoint latency threshold
    // when one matches "METHOD /route", else the global default).
    const triggerType = this.determineTriggerType(statusCode, durationMs, exception, method, route);
    if (triggerType === null) {
      return null;
    }

    // Mark operation hot for adaptive sampling BEFORE dedup checks.
    // This ensures the hot state is refreshed on every error occurrence,
    // not just when a snapshot passes dedup. Without this, the hot state
    // expires while dedup blocks snapshots, causing partial snapshots.
    markOperationHot(`${method} ${route}`);

    // Generate error hash for deduplication
    const errorHash = this.generateErrorHash(route, exception);

    // Check batch-level deduplication FIRST (one per error type per collection interval)
    if (this._currentBatchHashes.has(errorHash)) {
      diag.debug(`Incident snapshot batch-deduplicated (hash: ${errorHash})`);
      return null;
    }
    this._currentBatchHashes.add(errorHash);

    // Check period-level deduplication (limits same error over period_minutes)
    if (!this.checkDeduplication(errorHash)) {
      diag.debug(`Incident snapshot period-deduplicated (hash: ${errorHash})`);
      return null;
    }

    // Check rate limit AFTER dedup — only non-deduplicated requests consume slots.
    // Running rate limit before dedup causes phantom slot consumption.
    if (!this.checkRateLimit()) {
      diag.debug('Incident snapshot rate limit exceeded, skipping');
      return null;
    }

    // Collect incident snapshot data
    try {
      const snapshot = this.collectIncidentSnapshot(
        route,
        method,
        statusCode,
        durationMs,
        exception,
        requestData,
        triggerType
      );

      this._pendingSnapshots.push(snapshot);

      diag.info(`Incident snapshot triggered: ${route} ${method} (status=${statusCode}, trigger=${triggerType})`);

      // Return exemplar
      return {
        snapshot_id: snapshot.snapshot_id,
        trigger_type: snapshot.trigger_type,
        severity: snapshot.severity,
        timestamp: snapshot.timestamp,
      };
    } catch (err) {
      diag.error(`Error collecting incident snapshot data: ${err}`);
      return null;
    }
  }

  collect(): void {
    // Tick hot endpoints each collection cycle
    tickHotOperations();

    // Clear batch dedup set — allows same error type to produce one snapshot next interval
    this._currentBatchHashes.clear();

    // Swap pending snapshots
    const snapshots = this._pendingSnapshots;
    this._pendingSnapshots = [];

    if (snapshots.length === 0) {
      diag.debug('No incident snapshots to export');
      return;
    }

    if (this.otlpEmitter) {
      for (const snapshot of snapshots) {
        this.otlpEmitter.emitIncidentSnapshot(snapshot);
      }
      diag.info(`Emitted ${snapshots.length} IncidentSnapshot log records via OTLP`);
    }
  }

  // --- Trigger logic ---

  /**
   * Resolve the effective latency threshold (ms) for an operation.
   *
   * Matches "METHOD /route" (method uppercased) against the configured
   * OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS glob patterns, first match wins,
   * and falls back to the global durationThresholdMs when none match. Mirrors the
   * Java LatencyThresholdResolver (key = METHOD + ' ' + route; first glob match;
   * else global default).
   */
  private resolveLatencyThresholdMs(method: string, route: string): number {
    if (this.latencyThresholdPatterns.length === 0) {
      return this.durationThresholdMs;
    }
    const key = `${method.toUpperCase()} ${route}`;
    for (const [pattern, thresholdMs] of this.latencyThresholdPatterns) {
      if (minimatch(key, pattern)) {
        return thresholdMs;
      }
    }
    return this.durationThresholdMs;
  }

  private determineTriggerType(
    statusCode: number,
    durationMs: number,
    exception: Error | null,
    method?: string,
    route?: string
  ): string | null {
    // Priority: exception > latency
    if (exception !== null) {
      return 'exception';
    }
    if (statusCode >= 500) {
      return 'exception';
    }
    const thresholdMs =
      method !== undefined && route !== undefined
        ? this.resolveLatencyThresholdMs(method, route)
        : this.durationThresholdMs;
    if (durationMs > thresholdMs) {
      return 'latency';
    }
    return null;
  }

  private determineSeverity(statusCode: number, triggerType: string): string {
    if (statusCode >= 500 && statusCode <= 503) {
      return 'critical';
    }
    if (statusCode >= 504 || triggerType === 'exception') {
      return 'high';
    }
    if (triggerType === 'latency') {
      return 'medium';
    }
    return 'low';
  }

  // --- Rate limiting ---

  private checkRateLimit(): boolean {
    const currentTime = Date.now() / 1000; // seconds
    const cutoffTime = currentTime - this.periodSeconds;

    // Remove old timestamps
    this._snapshotTimestamps = this._snapshotTimestamps.filter(ts => ts >= cutoffTime);

    // Check limit
    if (this._snapshotTimestamps.length >= this.maxPerPeriod) {
      return false;
    }

    this._snapshotTimestamps.push(currentTime);
    return true;
  }

  // --- Deduplication ---

  private generateErrorHash(route: string, exception: Error | null): string {
    let hashInput: string;
    if (exception === null) {
      hashInput = `route:${route}`;
    } else {
      const excType = exception.constructor?.name ?? 'Error';
      const excMessage = exception.message ?? String(exception);
      hashInput = `route:${route}|exc:${excType}:${excMessage}`;
    }

    return crypto.createHash('md5').update(hashInput, 'utf-8').digest('hex');
  }

  private checkDeduplication(errorHash: string): boolean {
    const currentTime = Date.now() / 1000;
    const cutoffTime = currentTime - this.periodSeconds;

    // Clean up old hashes
    for (const [key, timestamps] of this._errorHashes) {
      const filtered = timestamps.filter(ts => ts >= cutoffTime);
      if (filtered.length === 0) {
        this._errorHashes.delete(key);
      } else {
        this._errorHashes.set(key, filtered);
      }
    }

    // Add timestamp FIRST (atomic add-then-check pattern)
    // This prevents race conditions where concurrent requests both pass the check
    const existing = this._errorHashes.get(errorHash);
    if (existing) {
      existing.push(currentTime);
    } else {
      this._errorHashes.set(errorHash, [currentTime]);
    }

    // Now check if we've exceeded the limit (use > because we already added)
    if (this._errorHashes.get(errorHash)!.length > this._maxSameError) {
      return false; // Deduplicate
    }

    return true;
  }

  // --- Snapshot collection ---

  private collectIncidentSnapshot(
    route: string,
    method: string,
    statusCode: number,
    durationMs: number,
    exception: Error | null,
    requestData: RequestData,
    triggerType: string
  ): IncidentSnapshot {
    const snapshotId = `snap_${uuidv4()}`;
    const severity = this.determineSeverity(statusCode, triggerType);
    const instanceId = this.resourceAttributes?.host_id || getInstanceId();

    // Collect exception info with call path
    const invData = this._monitorState.getInvestigationData();
    const exceptionInfo = this.collectExceptionInfo(exception, invData);

    // Detect is_partial: call_path has no timing data
    const isPartial = this.detectIsPartial(invData);

    // Build request context — opt-in gated payload fields per spec §5.
    // When the capture flag is OFF, emit only {type, timestamp, status_code}.
    const requestContext: RequestContext = {
      type: 'http',
      timestamp: Date.now(),
      status_code: statusCode,
      custom_context: {},
    };
    if (this.captureRequestBody) {
      requestContext.custom_context = this.extractCustomContext(requestData);
      requestContext.request_body = requestData.cachedBody ?? null;
      if (requestData.args) requestContext.query_params = requestData.args;
      if (requestData.viewArgs) requestContext.path_params = requestData.viewArgs;
      if (requestData.headers) requestContext.request_headers = requestData.headers;
    }

    // Build telemetry correlation (trace_id + span_id + correlation_ids only)
    const telemetryCorrelation: TelemetryCorrelation = {
      trace_id: this.extractTraceId(requestData) ?? undefined,
      span_id: this.extractSpanId(requestData) ?? undefined,
      correlation_ids: this.extractCorrelationIds(requestData),
    };

    return new IncidentSnapshot({
      snapshot_id: snapshotId,
      timestamp: Date.now(),
      severity,
      trigger_type: triggerType,
      service: this.serviceName,
      environment: this.environment,
      instance_id: instanceId,
      affected_endpoint: `${method} ${route}`,
      sdk_version: this.sdkVersion,
      pid: this.pid,
      duration_ms: durationMs,
      is_partial: isPartial,
      exception_info: exceptionInfo,
      request_context: requestContext,
      telemetry_correlation: telemetryCorrelation,
      resource_attributes: this.resourceAttributes,
      git_commit_sha: this.gitCommitSha,
      deployment_id: this.deploymentId,
    });
  }

  private detectIsPartial(invData: InvestigationData | null): boolean {
    if (!invData || !invData.callPath || invData.callPath.length === 0) {
      return false;
    }
    // is_partial if ANY call_path entry lacks timing data (matches Python's
    // `any(duration_ns == 0)`). Spec intent: partial means the snapshot is
    // missing timing for at least one frame, not only the case where every
    // frame is missing timing.
    return invData.callPath.some(entry => entry.durationNs === 0);
  }

  private collectExceptionInfo(exception: Error | null, invData: InvestigationData | null): ExceptionInfo[] {
    // If no explicit exception, check if the per-function monitor captured one
    if (exception === null) {
      if (!invData || !invData.exception) {
        // Latency/timeout incidents: no exception, but AST may have recorded
        // a call_path. Python parity (_collect_exception_info:771): return an
        // ExceptionInfo with empty exception fields so the snapshot still shows
        // which functions took time.
        const callPath = this.buildCallPath(invData);
        if (callPath.length > 0) {
          return [
            {
              exception_type: '',
              exception_message: '',
              stack_trace: '',
              call_path: callPath,
            },
          ];
        }
        return [];
      }
      const excData = invData.exception;
      const callPath = this.buildCallPath(invData);
      // traceback is stored as a raw string (deferred formatting optimization)
      const stackTrace = excData.traceback || `${excData.name}: ${excData.message}`;

      return [
        {
          exception_type: excData.name,
          // Truncate message + stack: they can carry PII / large payloads and are
          // emitted verbatim to CloudWatch on the default-on incident path.
          exception_message: truncateString(excData.message ?? '', MAX_EXCEPTION_MESSAGE_CHARS),
          stack_trace: truncateString(stackTrace, MAX_STACK_TRACE_CHARS),
          call_path: callPath,
        },
      ];
    }

    // Build call path
    const callPath = this.buildCallPath(invData);

    // Get exception details
    const excType = exception.constructor?.name ?? 'Error';
    const stackTrace = exception.stack ?? String(exception);

    return [
      {
        exception_type: excType,
        // Truncate message + stack: they can carry PII / large payloads and are
        // emitted verbatim to CloudWatch on the default-on incident path.
        exception_message: truncateString(exception.message ?? '', MAX_EXCEPTION_MESSAGE_CHARS),
        stack_trace: truncateString(stackTrace, MAX_STACK_TRACE_CHARS),
        call_path: callPath,
      },
    ];
  }

  private buildCallPath(invData: InvestigationData | null): CallPathEntry[] {
    const callPath: CallPathEntry[] = [];
    if (invData && invData.callPath) {
      for (const entry of invData.callPath) {
        // Look up isAsync and line from function registry
        const funcInfo = getFunctionInfo(entry.functionName);
        // spec §5: caller_function_name uses "" when null (cross-SDK parity with Java)
        const cpEntry: CallPathEntry = {
          function_name: entry.functionName,
          caller_function_name: entry.callerFunctionName ?? '',
          duration_ns: entry.durationNs,
          error: false,
        };
        if (funcInfo?.isAsync) {
          cpEntry.is_async = true;
        }
        if (funcInfo?.line !== undefined) {
          cpEntry.function_at_line = funcInfo.line;
        }
        callPath.push(cpEntry);
      }
    }
    return callPath;
  }

  // --- Data sanitization ---

  private extractCustomContext(requestData: RequestData): Record<string, string> {
    const customContext: Record<string, string> = {};
    const args = requestData.args ?? {};
    if (args.user_id) {
      customContext.user_id = String(args.user_id);
    }
    return customContext;
  }

  private extractTraceId(requestData: RequestData): string | null {
    // Try OTel span first
    try {
      const currentSpan = trace.getActiveSpan();
      if (currentSpan) {
        const spanContext = currentSpan.spanContext();
        if (spanContext.traceId && spanContext.traceId !== '00000000000000000000000000000000') {
          return spanContext.traceId;
        }
      }
    } catch {
      // Ignore
    }

    // Fallback to headers
    const headers = requestData.headers ?? {};
    const traceparent = headers.traceparent;
    if (traceparent) {
      const parts = traceparent.split('-');
      if (parts.length >= 2) {
        return parts[1];
      }
    }

    const xrayTrace = headers['X-Amzn-Trace-Id'] ?? headers['x-amzn-trace-id'];
    if (xrayTrace) {
      return xrayTrace;
    }

    const ddTraceId = headers['x-datadog-trace-id'];
    if (ddTraceId) {
      return ddTraceId;
    }

    return null;
  }

  private extractSpanId(requestData: RequestData): string | null {
    // Try OTel span first
    try {
      const currentSpan = trace.getActiveSpan();
      if (currentSpan) {
        const spanContext = currentSpan.spanContext();
        if (spanContext.spanId && spanContext.spanId !== '0000000000000000') {
          return spanContext.spanId;
        }
      }
    } catch {
      // Ignore
    }

    // Fallback to headers
    const headers = requestData.headers ?? {};
    const traceparent = headers.traceparent;
    if (traceparent) {
      const parts = traceparent.split('-');
      if (parts.length >= 3) {
        return parts[2];
      }
    }

    return null;
  }

  private extractCorrelationIds(_requestData: RequestData): Record<string, string> {
    return {};
  }
}
