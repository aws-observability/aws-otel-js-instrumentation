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
import { diag } from '@opentelemetry/api';
import { BaseCollector } from './base-collector';
import { ServiceEventsMonitorState, InvestigationData } from '../serviceevents-monitor';
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

/**
 * Correlation the span processor hands the collector for one request.
 *
 * `trace_id`/`span_id` are the span processor's SAMPLED-gated correlation (fix #1): set iff the
 * boundary span's trace was sampled, else undefined. They are the collector's ONLY source of trace
 * correlation — it never re-derives ids from the active span or inbound headers, because those
 * sources are not sampling-gated and would resurrect a link to a trace the backend never exported.
 */
export interface RequestData {
  trace_id?: string;
  span_id?: string;
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

  // Rate limiting
  private _snapshotTimestamps: number[] = [];
  private _maxSameError: number;

  // Deduplication
  private _errorHashes: Map<string, number[]> = new Map(); // hash -> [timestamp1, ...]
  private _currentBatchHashes: Set<string> = new Set(); // one snapshot per error type per collection interval

  // Pending snapshots
  private _pendingSnapshots: IncidentSnapshot[] = [];
  // Within a collection cycle, the single pending snapshot per error hash (batch dedup keeps
  // exactly one). Lets a later SAMPLED occurrence of the same error upgrade an earlier UNSAMPLED
  // pending snapshot's correlation before it flushes — see maybeUpgradePendingCorrelation. Cleared
  // each collect().
  private _pendingByHash: Map<string, IncidentSnapshot> = new Map();
  // The endpoint exemplar object returned for each pending snapshot, keyed by error hash. The
  // endpoint collector holds the SAME object reference, so mutating it on a Point #2 upgrade keeps
  // the recorded exemplar's emitted fields (trigger_type/timestamp) coherent with the swapped
  // snapshot (they share a snapshot_id). Cleared each collect().
  private _pendingExemplarByHash: Map<string, IncidentExemplar> = new Map();

  // Monitor state
  private _monitorState: ServiceEventsMonitorState;

  constructor(
    flushIntervalMs: number,
    durationThresholdMs: number,
    maxPerPeriod: number,
    environment?: string,
    serviceName?: string,
    sdkVersion: string = '0.0.0',
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

    this._maxSameError = maxSameError;

    this._monitorState = ServiceEventsMonitorState.getInstance();
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

    // Generate error hash for deduplication. The processor passes exception=null (like Java) and
    // defers exception detail to the collector, so recover the error identity (type + file-qualified
    // throw-site origin) from the investigation data — already seeded from the span's exception event
    // for uninstrumented 5xx — BEFORE hashing. Without this the hash would collapse to operation-only
    // and two distinct errors on the same operation would deduplicate together. The origin (not the
    // unbounded message) keeps the key bounded. The key uses the full operation (`<method> <route>`)
    // so different methods on one route are distinct incidents, matching Java. Latency incidents have
    // no exception → operation-only hash.
    const operation = `${method} ${route}`;
    const { type: excType, origin } = this.recoverErrorIdentity(exception);
    const errorHash = this.errorHash(operation, excType, origin);

    // Check batch-level deduplication FIRST (one per error type per collection interval)
    if (this._currentBatchHashes.has(errorHash)) {
      // A snapshot for this error is already pending this cycle. Batch dedup keeps that single
      // snapshot, but if it was built from an UNSAMPLED occurrence (no resolvable trace link, see
      // fix #1) and THIS occurrence is sampled, upgrade the pending snapshot in place so the one
      // snapshot we emit per cycle carries a resolvable trace link.
      this.maybeUpgradePendingCorrelation(
        errorHash,
        route,
        method,
        statusCode,
        durationMs,
        exception,
        requestData,
        triggerType
      );
      diag.debug(`Incident snapshot batch-deduplicated (hash: ${errorHash})`);
      return null;
    }

    // Both the period dedup cap and the rate limit are checked WITHOUT mutating
    // their state first, so a request rejected by either gate consumes neither a
    // dedup slot nor a rate-limit slot. Committing on rejection would poison the
    // other limiter — e.g. a rate-limited error would still record a dedup
    // occurrence and cause the next legitimate occurrence of that same error to be
    // dropped as a duplicate.

    // Check period-level deduplication (limits same error over the period).
    if (!this.isWithinDedupLimit(errorHash)) {
      diag.debug(`Incident snapshot period-deduplicated (hash: ${errorHash})`);
      return null;
    }

    // Check rate limit (pure — does not consume a slot yet).
    if (!this.hasRateLimitRoom()) {
      diag.debug('Incident snapshot rate limit exceeded, skipping');
      return null;
    }

    // All gates passed — a snapshot WILL be produced. Now commit to every limiter:
    // batch set, period dedup map, and rate-limit window. Doing this only here (not
    // before the checks) is what keeps rejected requests from poisoning the limiters.
    this._currentBatchHashes.add(errorHash);
    this.recordErrorHash(errorHash);
    this.recordEmission();

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

      // Build the exemplar for endpoint telemetry correlation. Keep a reference indexed by error
      // hash: the endpoint collector holds this SAME object, so a later Point #2 upgrade can mutate
      // it in place to track the swapped snapshot's emitted fields (trigger_type/timestamp).
      const exemplar: IncidentExemplar = {
        snapshot_id: snapshot.snapshot_id,
        trigger_type: snapshot.trigger_type,
        severity: snapshot.severity,
        timestamp: snapshot.timestamp,
      };

      // Add to pending, and index by error hash so a later sampled occurrence of the same error
      // can upgrade this snapshot's correlation in place before it flushes.
      this._pendingSnapshots.push(snapshot);
      this._pendingByHash.set(errorHash, snapshot);
      this._pendingExemplarByHash.set(errorHash, exemplar);

      diag.info(`Incident snapshot triggered: ${route} ${method} (status=${statusCode}, trigger=${triggerType})`);

      return exemplar;
    } catch (err) {
      diag.error(`Error collecting incident snapshot data: ${err}`);
      // Roll back the slots this attempt consumed. The batch/period-dedup/rate-limit slots were all
      // committed together just above, only after every pure check passed. If collection then fails,
      // leaving them committed would suppress a *later* identical error that could have produced a
      // snapshot — for up to the 60s dedup/rate windows — and (with Point #2) would leave errorHash in
      // the batch set with nothing in _pendingByHash, so a later sampled occurrence's upgrade finds no
      // pending snapshot and is silently dropped.
      this.rollbackReservation(errorHash);
      return null;
    }
  }

  collect(): void {
    // Clear batch dedup set — allows same error type to produce one snapshot next interval
    this._currentBatchHashes.clear();

    // Swap pending snapshots
    const snapshots = this._pendingSnapshots;
    this._pendingSnapshots = [];
    // Drop the per-hash indexes for the drained cycle; the upgrade window is one cycle.
    this._pendingByHash = new Map();
    this._pendingExemplarByHash = new Map();

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
   *
   * The trigger decision uses this internally (see determineTriggerType). Kept public so it
   * can be unit-tested directly against the configured glob patterns — mirrors the Python
   * distro's get_latency_threshold, which is likewise public and exercised by its own tests.
   */
  resolveLatencyThresholdMs(method: string, route: string): number {
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

  /**
   * True if the rate-limit window has room for another snapshot. Pure check — does
   * NOT consume a slot. Call `recordEmission()` only once the snapshot actually emits
   * (i.e. after every gate has passed) so deduplicated requests never consume slots.
   */
  private hasRateLimitRoom(): boolean {
    const currentTime = Date.now() / 1000; // seconds
    const cutoffTime = currentTime - this.periodSeconds;
    this._snapshotTimestamps = this._snapshotTimestamps.filter(ts => ts >= cutoffTime);
    return this._snapshotTimestamps.length < this.maxPerPeriod;
  }

  /** Consume a rate-limit slot. Call only when a snapshot is actually emitted. */
  private recordEmission(): void {
    this._snapshotTimestamps.push(Date.now() / 1000);
  }

  // --- Deduplication ---

  /**
   * Recover the {type, origin} that keys the dedup hash.
   *
   * The endpoint span processor passes `exception=null` (like Java) and defers exception detail to
   * the collector, so the dedup key must be recovered from the same investigation data the snapshot
   * body uses. Without this the hash would collapse to operation-only and two distinct errors on the
   * same operation would deduplicate together (defeating per-error incident coverage).
   *
   * The second field is the *file-qualified throw-site origin* (`file.function`), not the exception
   * message. The message is unbounded — it routinely embeds request-specific data (IDs, timestamps,
   * values) — so keying on it lets a single recurring error spawn a distinct hash per occurrence,
   * defeating dedup and churning the per-window hash map against its size cap. The origin is bounded
   * and stable across deploys. It is file-qualified so two same-named functions in different modules
   * don't collide into one incident, mirroring the composite name the AST monitor assigns
   * instrumented frames (see `calculateFunctionName`) and Java's `class.method`.
   *
   * This value is used ONLY for the dedup hash. Customer-consumed telemetry (the endpoint error
   * breakdown key and the snapshot body `function_name`) is left untouched — those still carry the
   * bare/monitor-recorded name, so this change does not alter emitted data.
   *
   * - When an explicit `exception` object is supplied (manual callers), take the type from it and
   *   the origin from the first frame of its stack (the throw site).
   * - Otherwise PEEK the per-request investigation data — the AST monitor's captured exception, or
   *   the span's exception event seeded into it by the processor for uninstrumented 5xx — and
   *   qualify the origin from the captured `traceback` string.
   * - A latency incident (no exception anywhere) returns {type: null} → operation-only hash, matching
   *   the pre-refactor behavior for slow requests.
   *
   * Best-effort and guarded: hashing must never crash the host, so any failure degrades to
   * {type: null} (operation-only), the safe default.
   */
  private recoverErrorIdentity(exception: Error | null): { type: string | null; origin: string } {
    try {
      if (exception !== null) {
        return {
          type: exception.constructor?.name ?? 'Error',
          origin: this.originFromStack(exception.stack, exception.message),
        };
      }
      const invData = this._monitorState.peekInvestigationData();
      const excData = invData?.exception;
      if (excData && excData.name) {
        return { type: excData.name, origin: this.originFromStack(excData.traceback, excData.message) };
      }
    } catch (err) {
      diag.debug(`Failed to recover error identity for dedup hash: ${err}`);
    }
    return { type: null, origin: '' };
  }

  /**
   * Build a file-qualified origin (`<basename>.<function>`) from the top frame of a V8 stack trace.
   *
   * Parses the SINGLE top `at` frame so the function name and file always come from the same frame —
   * V8 frames read `    at functionName (/path/to/file.js:line:col)` or, for anonymous/top-level
   * frames, the bare `    at /path/to/file.js:line:col`. The `async ` prefix and `[as alias]` suffix
   * V8 attaches to some frames are stripped so they don't leak into the key, and the `:line:col`
   * suffix is dropped (deploy-unstable). The basename (extension stripped) matches the AST monitor's
   * `calculateFunctionName` shape. Used ONLY for the dedup hash; returns '' when the stack is
   * absent/unparseable (→ operation-only key, the safe default). The line-anchored match tolerates
   * Windows drive-letter paths (`C:\...`), which a colon-delimited scan would mis-split.
   *
   * `message` is the exception message: V8 renders the stack as `<Name>: <message>` followed by the
   * frames, so the leading `1 + newlines(message)` lines are the header. Dropping them first means a
   * MULTI-LINE message that itself embeds indented `at …` text cannot be mis-parsed as the top frame
   * (which would inject a request-specific origin and reintroduce unbounded-key proliferation).
   */
  private originFromStack(stack: string | undefined, message: string | undefined): string {
    if (!stack) {
      return '';
    }
    // Drop the header lines (the `<Name>: <message>` block) so message text can't be read as a frame.
    // Slice unconditionally: for a header-only stack (no real frames) this leaves nothing to parse
    // and the regex below returns '' — NOT falling through to parse the message as a frame.
    const lines = stack.split('\n');
    const headerLines = 1 + (message ? message.match(/\n/g)?.length ?? 0 : 0);
    const body = lines.slice(headerLines).join('\n');
    // First "\tat …" frame line — the throw site (most-recent-call-first).
    const frameLine = body.match(/^[ \t]+at[ \t]+(.+)$/m);
    if (!frameLine) {
      return '';
    }
    const frame = frameLine[1].trim();
    // "functionName (location)" vs a bare "location" (anonymous/top-level) frame.
    const parenMatch = frame.match(/^(.*?)\s+\((.*)\)$/);
    let fn = parenMatch ? parenMatch[1] : '';
    const location = parenMatch ? parenMatch[2] : frame;
    // V8 decorates some frames with an `async ` prefix or an `[as alias]` suffix — neither is part
    // of the stable identity, so strip both. Treat the explicit `<anonymous>` marker as no name.
    fn = fn
      .replace(/^async\s+/, '')
      .replace(/\s+\[as .+\]$/, '')
      .trim();
    if (fn === '<anonymous>') {
      fn = '';
    }
    // Strip the trailing `:line:col` (deploy-unstable) from the location to get the file path.
    const locMatch = location.match(/^(.*):\d+:\d+$/);
    const filePath = locMatch ? locMatch[1] : location;
    const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
    const basename = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i, '');
    if (!basename) {
      return fn; // no resolvable file → fall back to the bare function name (may be '')
    }
    return fn ? `${basename}.${fn}` : basename;
  }

  /**
   * Hash the dedup key from operation + recovered exception type/origin.
   *
   * Keyed `op:<operation>` for latency (no exception) or `op:<operation>|exc:<type>:<origin>` for
   * errors, following the same `op:`/`|exc:` scheme as the Python and Java distros. The operation is
   * `<method> <route>`, so different HTTP methods on one route are distinct incidents. The
   * file-qualified origin (not the message) keeps the key bounded — see `recoverErrorIdentity`.
   *
   * Hashes are compared only within a distro, never across them, so the strings need not be
   * byte-identical between distros — and they are not: when the origin is unresolvable this distro
   * emits a trailing `:` (empty origin), whereas Java omits the `:origin` segment entirely.
   */
  private errorHash(operation: string, excType: string | null, origin: string): string {
    const hashInput = excType === null ? `op:${operation}` : `op:${operation}|exc:${excType}:${origin}`;
    return crypto.createHash('md5').update(hashInput, 'utf-8').digest('hex');
  }

  /**
   * True if emitting this error now would NOT exceed the per-period same-error cap.
   * Pure check — does NOT record the occurrence. Prunes expired timestamps (idempotent
   * cleanup), but never mutates the count for `errorHash`. Call `recordErrorHash()` only
   * once the snapshot actually emits, so a rate-limited error never poisons the dedup
   * map and drop the next legitimate occurrence of the same error.
   */
  private isWithinDedupLimit(errorHash: string): boolean {
    const currentTime = Date.now() / 1000;
    const cutoffTime = currentTime - this.periodSeconds;

    // Clean up expired hashes (does not affect the add-then-emit decision below).
    for (const [key, timestamps] of this._errorHashes) {
      const filtered = timestamps.filter(ts => ts >= cutoffTime);
      if (filtered.length === 0) {
        this._errorHashes.delete(key);
      } else {
        this._errorHashes.set(key, filtered);
      }
    }

    // Would-be count if we recorded now = current live count + 1.
    const liveCount = this._errorHashes.get(errorHash)?.length ?? 0;
    return liveCount + 1 <= this._maxSameError;
  }

  /** Record this error occurrence against the per-period dedup cap. Call only on emit. */
  private recordErrorHash(errorHash: string): void {
    const currentTime = Date.now() / 1000;
    const existing = this._errorHashes.get(errorHash);
    if (existing) {
      existing.push(currentTime);
    } else {
      this._errorHashes.set(errorHash, [currentTime]);
    }
  }

  /**
   * Undo the batch/period-dedup/rate-limit slots claimed for a failed collection.
   *
   * Best-effort and guarded: this runs on an error path, so it must not throw. Removes the batch
   * hash, the most-recent period-dedup timestamp for this hash, and the most-recent rate-limit
   * timestamp — the three slots claimed just before collection in processPotentialIncident for this
   * attempt. Mirrors the Python distro's `_rollback_reservation`.
   */
  private rollbackReservation(errorHash: string): void {
    try {
      this._currentBatchHashes.delete(errorHash);
      // No snapshot/exemplar was indexed for this failed attempt (indexing happens only after a
      // successful collection), but drop any stale entries defensively so the batch set and the
      // pending indexes stay consistent for a later sampled occurrence's upgrade.
      this._pendingByHash.delete(errorHash);
      this._pendingExemplarByHash.delete(errorHash);
      const timestamps = this._errorHashes.get(errorHash);
      if (timestamps && timestamps.length > 0) {
        timestamps.pop(); // drop the timestamp this attempt added
        if (timestamps.length === 0) {
          this._errorHashes.delete(errorHash);
        }
      }
      if (this._snapshotTimestamps.length > 0) {
        this._snapshotTimestamps.pop(); // drop the slot this attempt added
      }
    } catch (err) {
      diag.debug(`Failed to roll back incident reservation: ${err}`);
    }
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

    // Collect exception info with call path. Peek (non-mutating) — the per-request
    // get-and-clear (which also decrements _investigationActiveCount) is owned by the
    // framework finish path. Clearing here would double-decrement the active count and
    // strip the ALS data from any concurrent request still being investigated.
    const invData = this._monitorState.peekInvestigationData();
    const exceptionInfo = this.collectExceptionInfo(exception, invData);

    // Detect is_partial: call_path has no timing data
    const isPartial = this.detectIsPartial(invData);

    // Build request context. Request-payload capture (body/query/path/headers) is
    // not emitted — only the non-PII envelope {type, timestamp, status_code}.
    const requestContext: RequestContext = {
      type: 'http',
      timestamp: Date.now(),
      status_code: statusCode,
      custom_context: {},
    };

    // Build telemetry correlation. trace_id/span_id come straight from requestData, where the span
    // processor already gated them on the real SAMPLED flag (fix #1): set iff the trace was sampled,
    // else undefined (an unsampled request emits a complete, self-contained snapshot with empty
    // correlation). They are NOT re-derived from the active span or inbound headers — those sources
    // are not sampling-gated and would resurrect a link to a trace the backend never exported. The
    // span processor is the single, sampling-gated source of correlation truth.
    const telemetryCorrelation: TelemetryCorrelation = {
      trace_id: requestData.trace_id,
      span_id: requestData.span_id,
      correlation_ids: {},
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

  // --- In-batch sampled-preference upgrade ---

  /**
   * Upgrade a pending UNSAMPLED snapshot to this SAMPLED occurrence (whole-snapshot swap).
   *
   * Trace correlation is sampling-conditional (fix #1): an unsampled request emits a snapshot with
   * no trace_id. Because batch dedup keeps exactly one snapshot per error hash per cycle, that
   * single snapshot inherits the FIRST occurrence's sampling state — so under reduced sampling it
   * usually carries no resolvable trace link even if a sampled occurrence of the same error happens
   * moments later in the same cycle.
   *
   * When this occurrence IS sampled (requestData carries a trace_id) and the pending snapshot is NOT
   * (its trace_id is undefined), replace the pending snapshot WHOLESALE with a freshly collected one
   * for this occurrence, preserving the original snapshot_id so the endpoint exemplar pointer stays
   * valid. The replacement is whole-snapshot (not correlation-only) so the body — stack trace, call
   * path, duration, timestamp — stays coherent with the trace it links to. First sampled occurrence
   * wins; once upgraded, later occurrences are left alone. No-op (so the original is preserved) on
   * any failure — telemetry must never crash the host.
   */
  private maybeUpgradePendingCorrelation(
    errorHash: string,
    route: string,
    method: string,
    statusCode: number,
    durationMs: number,
    exception: Error | null,
    requestData: RequestData,
    triggerType: string
  ): void {
    // Only sampled occurrences can upgrade — an unsampled one has nothing better to offer.
    // requestData.trace_id is the span processor's SAMPLED-gated correlation (fix #1): present iff
    // the trace was sampled, so it is the authoritative "is this sampled?" signal.
    if (!requestData.trace_id) {
      return;
    }
    try {
      const pending = this._pendingByHash.get(errorHash);
      // Upgrade only an uncorrelated pending snapshot; if it already has a trace_id, the first
      // sampled occurrence already won.
      if (!pending || pending.telemetry_correlation.trace_id !== undefined) {
        return;
      }

      // triggerType is the caller's already-computed value for this same occurrence — reuse it
      // rather than recomputing (this occurrence reached the batch-dedup branch, so it triggered).
      const replacement = this.collectIncidentSnapshot(
        route,
        method,
        statusCode,
        durationMs,
        exception,
        requestData,
        triggerType
      );
      // Preserve the original identity so the already-emitted endpoint exemplar pointer stays valid.
      replacement.snapshot_id = pending.snapshot_id;
      // Preserve the original affected_endpoint too. The dedup hash keys on operation
      // (`<method> <route>`), so only occurrences sharing an operation (e.g. two GET /api/x with the
      // same error) share a hash and can upgrade each other. The endpoint exemplar is filed under the
      // FIRST occurrence's operation key; rebuilding affected_endpoint from THIS occurrence would make
      // the swapped snapshot's operation disagree with the endpoint summary that references its
      // snapshot_id. Keep the first one.
      replacement.affected_endpoint = pending.affected_endpoint;

      const idx = this._pendingSnapshots.indexOf(pending);
      if (idx < 0) {
        return;
      }
      this._pendingSnapshots[idx] = replacement;
      this._pendingByHash.set(errorHash, replacement);
      // The whole-snapshot swap can change trigger_type/timestamp (a later occurrence may have a
      // different status or fire later). The endpoint exemplar was already recorded pointing at this
      // snapshot_id, so update the SAME object in place — the endpoint collector holds this reference
      // — to keep the emitted fields coherent with the snapshot they link to. Only trigger_type and
      // timestamp are serialized onto the wire (the emitter drops severity), so those are what we sync.
      const exemplar = this._pendingExemplarByHash.get(errorHash);
      if (exemplar) {
        exemplar.trigger_type = replacement.trigger_type;
        exemplar.timestamp = replacement.timestamp;
      }
      diag.debug(`Upgraded pending incident snapshot to a sampled occurrence (hash: ${errorHash})`);
    } catch (err) {
      // Match the primary collection path's visibility (processPotentialIncident logs at error);
      // a failure here silently keeps the stale uncorrelated snapshot, which must not go unseen.
      diag.error(`Failed to upgrade pending incident correlation: ${err}`);
    }
  }
}
