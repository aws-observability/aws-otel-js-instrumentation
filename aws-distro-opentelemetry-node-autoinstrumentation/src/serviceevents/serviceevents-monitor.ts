// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ServiceEvents function monitoring - core state and fast-path functions.
 *
 * Provides:
 * - ServiceEventsMonitorState: Singleton holding all aggregation data
 * - __serviceeventsMonitorEnter / __serviceeventsMonitorExit / __serviceeventsMonitorException:
 *   Fast functions called by AST-injected code in every wrapped function
 * - AsyncLocalStorage contexts for endpoint ID and investigation data
 *
 * Performance-critical design:
 * - Global call stack array instead of AsyncLocalStorage (avoids async_hooks overhead)
 * - Plain object call counters instead of Map (V8 hidden-class optimized)
 * - performance.now() for timing instead of process.hrtime.bigint() (avoids BigInt allocation + system call)
 * - Investigation-active counter to skip ALS lookups when no investigation is running
 * - Single ALS lookup in exit path (down from 4+) when investigation is inactive
 * - SEH histogram recordUnsafe() skips validation for internal timing data
 * - Last-bucket cache in updateAggregations to skip Map lookups for repeated function calls
 *
 * JS adaptation notes:
 * - No locks needed (Node.js is single-threaded)
 * - Uses AsyncLocalStorage for endpoint ID and investigation (per-request state)
 * - Uses performance.now() for microsecond-precision timing (sufficient for function durations)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { diag, type Histogram } from '@opentelemetry/api';
import { SEHHistogram } from './utils/seh-histogram';
// One-way edge: this module imports from ast-transformation. The reverse
// import would create a CommonJS cycle whose partial-exports symptoms
// (undefined monitor functions in the AST loader at require-time) are
// subtle. The function registry is module-singleton state inside
// ast-transformation, deliberately decoupled from monitor state.
import { type FunctionRegistryEntry, getFunctionInfo } from './ast-transformation';

// ============================================================================
// Sampling Configuration
// ============================================================================

let _sampleTier1Threshold = 100;
let _sampleTier2Threshold = 1000;
let _sampleTier2Rate = 10;
let _sampleTier3Rate = 100;

let _samplingMode: string = 'auto'; // "auto", "adaptive", "always", or "never"

// ============================================================================
// Dynamic Function Detach (performance optimization)
// ============================================================================
// When function call rate exceeds a threshold, disable per-function instrumentation
// entirely — Enter returns null, Exit early-returns. The try/finally wrapper becomes
// a no-op (just `if(null)` in the finally block).
//
// At high TPS, the overhead of per-function tracking is not worth the data quality.
// Endpoint-level metrics (from Express middleware) continue to work normally.

/** Running mode: 1 = normal (per-function tracking), 2 = detached (skip per-function) */
let _runningMode = 1;

/** Calls per second threshold to trigger detach. 0 = never detach. */
let _detachThreshold = 0; // Set from config; 0 means auto-detect or disabled

/** Interval timer for detach check */
let _detachCheckTimer: ReturnType<typeof setInterval> | null = null;

/** Call counter for rate measurement */
let _callsThisPeriod = 0;
let _lastDetachCheckTime = Date.now();
let _detachStartTime = 0;

/**
 * Configure the detach threshold. Called during initialization.
 * @param threshold - Calls/sec to trigger detach. 0 = disabled.
 */
export function setDetachThreshold(threshold: number): void {
  _detachThreshold = threshold;
  if (threshold > 0 && !_detachCheckTimer) {
    _detachCheckTimer = setInterval(_checkDetach, 2000);
    _detachCheckTimer.unref();
  }
}

function _checkDetach(): void {
  const now = Date.now();
  const elapsed = (now - _lastDetachCheckTime) / 1000;
  if (elapsed <= 0) return;

  // Sum call counts
  let totalCalls = 0;
  for (const key of Object.keys(_callCounts)) {
    totalCalls += _callCounts[key] || 0;
  }
  const rate = (totalCalls - _callsThisPeriod) / elapsed;
  _callsThisPeriod = totalCalls; // Remember current total for next diff
  _lastDetachCheckTime = now;

  if (_detachThreshold <= 0) return;

  if (rate > _detachThreshold && _runningMode === 1) {
    _runningMode = 2;
    _detachStartTime = now;
    diag.info(`ServiceEvents: function detach ON (${Math.round(rate)}/s > ${_detachThreshold}/s threshold)`);
  } else if (_runningMode === 2) {
    // Stay detached for at least 10s before considering re-attach (prevents flapping)
    const detachedDuration = (now - _detachStartTime) / 1000;
    if (detachedDuration >= 10 && rate <= _detachThreshold * 0.5) {
      _runningMode = 1;
      diag.info(
        `ServiceEvents: function detach OFF (${Math.round(rate)}/s <= ${Math.round(
          _detachThreshold * 0.5
        )}/s after ${Math.round(detachedDuration)}s)`
      );
    }
  }
}

// ============================================================================
// Hot Endpoint Tracking (for adaptive sampling)
// ============================================================================

let _hotEndpointCycles = 100;

/** Map of operation → remaining hot cycles (key is "METHOD /route"). */
const _hotOperations: Record<string, number> = Object.create(null);

/**
 * Mark an operation as hot so adaptive sampling promotes it.
 */
export function markOperationHot(operation: string): void {
  _hotOperations[operation] = _hotEndpointCycles;
}

/**
 * Tick down hot-operation counters. Call once per collection cycle.
 */
export function tickHotOperations(): void {
  for (const key of Object.keys(_hotOperations)) {
    _hotOperations[key]--;
    if (_hotOperations[key] <= 0) {
      delete _hotOperations[key];
    }
  }
}

/**
 * Check if an operation is currently hot.
 */
export function isOperationHot(operation: string): boolean {
  return operation in _hotOperations;
}

/**
 * Call counters keyed by functionName. Plain object is faster than Map for
 * string keys because V8 can optimize property access via hidden classes.
 */
const _callCounts: Record<string, number> = Object.create(null);

export function setSamplingMode(mode: string): void {
  if (mode !== 'always' && mode !== 'never' && mode !== 'auto' && mode !== 'adaptive') {
    throw new Error(`Invalid sampling mode: '${mode}'`);
  }
  _samplingMode = mode;
}

export function getSamplingMode(): string {
  return _samplingMode;
}

export function setSamplingThresholds(opts: {
  tier1Threshold?: number;
  tier2Threshold?: number;
  tier2Rate?: number;
  tier3Rate?: number;
  hotEndpointCycles?: number;
}): void {
  if (opts.tier1Threshold !== undefined) _sampleTier1Threshold = opts.tier1Threshold;
  if (opts.tier2Threshold !== undefined) _sampleTier2Threshold = opts.tier2Threshold;
  if (opts.tier2Rate !== undefined) _sampleTier2Rate = opts.tier2Rate;
  if (opts.tier3Rate !== undefined) _sampleTier3Rate = opts.tier3Rate;
  if (opts.hotEndpointCycles !== undefined) _hotEndpointCycles = opts.hotEndpointCycles;
}

/**
 * Sampling decision for a function call. Called from __serviceeventsMonitorEnter on
 * every invocation, so it is on the hot path.
 *
 * Tiered sampling: 100% for the first tier-1 calls, then every Nth in tier 2, then
 * every Mth in tier 3. In 'adaptive' mode a hot operation forces sampling regardless
 * of call count; 'always'/'never' short-circuit.
 *
 * Exported so unit tests can assert the tier math and mode transitions directly.
 */
export function shouldSampleFast(totalCalls: number): boolean {
  if (_samplingMode === 'always') return true;
  if (_samplingMode === 'never') return false;
  // Adaptive: check if current endpoint is hot
  if (_samplingMode === 'adaptive') {
    const op = operationStorage.getStore() ?? null;
    if (op && isOperationHot(op)) return true;
  }
  // Tier sampling
  if (totalCalls <= _sampleTier1Threshold) return true;
  if (totalCalls <= _sampleTier2Threshold) return totalCalls % _sampleTier2Rate === 0;
  return totalCalls % _sampleTier3Rate === 0;
}

// ============================================================================
// Global Call Stack (replaces AsyncLocalStorage for performance)
// ============================================================================

/**
 * Global call stack implemented as a simple array with index counter.
 * This replaces AsyncLocalStorage<string[]> to avoid the overhead of
 * async_hooks on every function enter/exit.
 *
 * Trade-off: caller info may be imprecise across async boundaries between
 * requests. Within any synchronous call chain (which is the common case for
 * CPU-bound work like fibonacci), the stack is perfectly accurate. The caller
 * data is used for statistical aggregation (callerMap), so occasional
 * imprecision in async-interleaved cases is acceptable.
 */
const _globalStack: string[] = [];
let _globalStackIdx = -1;

/** Cached singleton reference to avoid getInstance() overhead on every exit call. */
let _monitorState: ServiceEventsMonitorState | null = null;

function _getMonitorState(): ServiceEventsMonitorState {
  if (_monitorState === null) {
    _monitorState = ServiceEventsMonitorState.getInstance();
  }
  return _monitorState;
}

// ============================================================================
// AsyncLocalStorage Contexts (only for per-request state)
// ============================================================================

/** Per-request operation string, populated by framework hooks as "METHOD /route". */
const operationStorage = new AsyncLocalStorage<string | null>();

/** Per-request investigation data (set when investigation is active). */
export interface InvestigationData {
  callPath: Array<{
    functionName: string;
    callerFunctionName: string | null;
    durationNs: number;
  }>;
  exception: {
    name: string;
    message: string;
    traceback: string;
    functionName: string;
  } | null;
  startTime: number; // Date.now() timestamp
}

const investigationStorage = new AsyncLocalStorage<InvestigationData | null>();

/**
 * Counter tracking how many concurrent requests have an active investigation.
 * When 0, the exit path can skip investigation-related ALS lookups entirely.
 * Uses a counter (not boolean) to handle concurrent async requests correctly.
 */
let _investigationActiveCount = 0;

/**
 * Whether the monitor globals are active. AST-transformed user code captures
 * `globalThis.__serviceeventsMonitorEnter/Exit/Exception` at module load and keeps
 * calling them for the process lifetime — deleting the globals on shutdown cannot
 * reach those captured references. Instead the hot-path functions check this flag
 * and become no-ops once `unregisterMonitorGlobals()` runs, so post-shutdown calls
 * stop mutating aggregation state (which no collector is draining anymore) and
 * memory does not grow unbounded.
 *
 * Defaults to true so the monitor functions are active whenever they're called
 * (including direct unit-test invocation); only `unregisterMonitorGlobals()` (called
 * from instrumentation shutdown) flips it false.
 *
 * Concurrency: this is a plain module-level flag read on the hot path and written
 * once at shutdown. That is safe because Node.js runs JS single-threaded — there is
 * no torn read/write. A worker thread that loaded this module would get its OWN
 * module instance (and its own flag), so there is no shared mutable across threads
 * either. The "worker threads" note on resetMonitorState refers to resetting that
 * per-thread instance, not to sharing this flag.
 */
let _monitorEnabled = true;

// ============================================================================
// Operation (Per-Request) Functions
// ============================================================================

export function setCurrentOperation(operation: string): void {
  operationStorage.enterWith(operation);
  // Hot status no longer cached per-request — sampling is inline in AST
}

export function getCurrentOperation(): string | null {
  return operationStorage.getStore() ?? null;
}

export function clearCurrentOperation(): void {
  operationStorage.enterWith(null);
}

// ============================================================================
// Call Stack Functions
// ============================================================================

/**
 * Get a snapshot of the current call stack.
 * Returns a copy of the global stack up to the current depth.
 */
export function getCallStack(): string[] {
  if (_globalStackIdx < 0) {
    return [];
  }
  return _globalStack.slice(0, _globalStackIdx + 1);
}

// ============================================================================
// Aggregation Bucket
// ============================================================================

export interface AggregationBucket {
  count: number;
  sampledCount: number;
  sumDuration: number;
  sumSquaredDuration: number;
  exceptions: Map<string, number>;
  callerMap: Map<string, number>;
  sehHistogram: SEHHistogram;
}

function createAggregationBucket(): AggregationBucket {
  return {
    count: 0,
    sampledCount: 0,
    sumDuration: 0,
    sumSquaredDuration: 0,
    exceptions: new Map(),
    callerMap: new Map(),
    sehHistogram: new SEHHistogram(100), // CloudWatch EMF limit
  };
}

// ============================================================================
// ServiceEventsMonitorState (Singleton)
// ============================================================================

/**
 * Aggregation type: functionName → operation → AggregationBucket
 */
export type Aggregations = Map<string, Map<string | null, AggregationBucket>>;

export class ServiceEventsMonitorState {
  private static _instance: ServiceEventsMonitorState | null = null;

  /**
   * Aggregation store.
   * Structure: { functionName: { operation: AggregationBucket } }
   */
  private _aggregations: Aggregations = new Map();

  /**
   * Last-bucket cache: avoids 2 Map.get() calls when the same function+operation
   * is called repeatedly (common in recursive/hot paths like fibonacci).
   */
  private _lastFunctionName: string = '';
  private _lastOperation: string | null | undefined = undefined;
  private _lastBucket: AggregationBucket | null = null;

  /**
   * Direct OTel histogram recording (bypasses SEH pre-aggregation for the
   * metric path). Wired by `ServiceEventsInstrumentation.initialize()` once
   * the dedicated MeterProvider has been built. Stays null when running in
   * `output_file` mode where the file metric exporter only handles Sums.
   */
  private _functionDurationHistogram: Histogram | null = null;

  /**
   * Shared signal-level attributes for the duration Histogram. Populated
   * once during init and never mutated afterwards, so __exit can build
   * per-call attrs by copying this dict and adding per-call keys.
   *
   * Service identity (`service.name`, `aws.local.service`,
   * `deployment.environment.name`) plus VCS/deployment metadata live on the
   * OTel Resource attached to the dedicated MeterProvider, so they are NOT
   * mirrored here — they ride along with every data point automatically.
   */
  private _metricBaseAttrs: Record<string, string | number | boolean> = {};

  private constructor() {}

  static getInstance(): ServiceEventsMonitorState {
    if (ServiceEventsMonitorState._instance === null) {
      ServiceEventsMonitorState._instance = new ServiceEventsMonitorState();
    }
    return ServiceEventsMonitorState._instance;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    ServiceEventsMonitorState._instance = null;
  }

  /**
   * Snapshot the shared attribute set used by the function-duration metric.
   *
   * `service.function.duration` (Histogram) builds its per-call attribute
   * dict on top of these base attrs. Should be called before the instrument
   * is wired so the first recorded call sees a fully-populated attribute set.
   *
   * The argument is copied (not stored by reference) so external mutation
   * can't poison readers; never mutated after.
   */
  setMetricBaseAttrs(baseAttrs: Record<string, string | number | boolean>): void {
    this._metricBaseAttrs = { ...baseAttrs };
  }

  /**
   * Wire the OTel Histogram instrument used for direct recording at call time.
   *
   * Called once during `ServiceEventsInstrumentation.initialize()` after the
   * dedicated MeterProvider is built. Enables `__serviceeventsMonitorExit` to
   * record raw durations directly into the OTel Exponential Histogram,
   * bypassing the SEH pre-aggregation path (which remains for EMF fallback).
   *
   * Pass null to detach (used by tests).
   */
  setFunctionDurationHistogram(histogram: Histogram | null): void {
    this._functionDurationHistogram = histogram;
  }

  /** True when the OTel histogram has been wired. */
  hasFunctionDurationHistogram(): boolean {
    return this._functionDurationHistogram !== null;
  }

  /**
   * Record a function call into the OTel metrics pipeline, if the histogram
   * is wired.
   *
   * `service.function.duration` (Histogram) is recorded only when the
   * histogram is wired AND the call was sampled — non-sampled calls would
   * record duration_ns=0 and pollute sum/min/percentiles. The per-call
   * attribute dict is built on top of `_metricBaseAttrs`, populated
   * separately via `setMetricBaseAttrs`.
   *
   * `functionLine` and `isAsync` are resolved from the function registry by
   * `__serviceeventsMonitorEnter` and stashed on the MonitorContext, so this
   * hot path doesn't pay for a per-call `Map.get`.
   *
   * The attribute object is allocated fresh on every recorded call. A
   * pooled/scratch object is NOT safe here: the OTel JS SDK's
   * `AttributeHashMap` retains the caller-supplied object as the bucket key
   * (see `node_modules/@opentelemetry/sdk-metrics/.../HashMap.js`), so
   * mutating the same object across calls with different
   * `(function.name, status)` would corrupt previously stored bucket keys.
   *
   * When the histogram is wired this is the source of truth for the
   * function-call signal: the exit path skips `updateAggregations` and the
   * `FunctionCallCollector` flushes as a no-op. The histogram carries
   * per-call dimensions (function.name, operation, status); total
   * invocation count, exception class breakdown, and caller_map are not
   * emitted on this path. See the Python `record_function_call_metrics` for
   * parity.
   */
  recordFunctionCallMetrics(
    functionName: string,
    durationNs: number,
    isSampled: boolean,
    caller: string | null | undefined,
    exceptionName: string | undefined,
    functionLine: number | undefined,
    isAsync: boolean
  ): void {
    const histogram = this._functionDurationHistogram;
    if (histogram === null || !isSampled) {
      return;
    }

    // Copy the write-once base dict and add per-call keys directly.
    const attrs: Record<string, string | number | boolean> = { ...this._metricBaseAttrs };
    attrs['function.name'] = functionName;
    const operation = operationStorage.getStore() ?? null;
    if (operation) {
      attrs['operation'] = operation;
    }
    if (caller) {
      attrs['aws.service_events.caller'] = caller;
    }
    if (functionLine !== undefined) {
      attrs['aws.service_events.function_at_line'] = functionLine;
    }
    if (isAsync) {
      attrs['aws.service_events.async'] = true;
    }

    attrs['status'] = exceptionName ? 'error' : 'success';

    const durationUs = durationNs / 1000.0;
    histogram.record(durationUs, attrs);
  }

  /**
   * Fast path: just increment the count for an unsampled call.
   * Avoids all the Map lookups and bucket updates of updateAggregations.
   * The count is tracked per-function (not per-endpoint) for unsampled calls.
   */
  incrementCount(functionName: string): void {
    // Use last-bucket cache if same function
    if (this._lastFunctionName === functionName && this._lastBucket !== null) {
      this._lastBucket.count += 1;
      return;
    }
    // Cache miss: look up the null-operation bucket (default for unsampled)
    let operationMap = this._aggregations.get(functionName);
    if (!operationMap) {
      operationMap = new Map();
      this._aggregations.set(functionName, operationMap);
    }
    let agg = operationMap.get(null);
    if (!agg) {
      agg = createAggregationBucket();
      operationMap.set(null, agg);
    }
    agg.count += 1;
    // Update cache
    this._lastFunctionName = functionName;
    this._lastOperation = null;
    this._lastBucket = agg;
  }

  /**
   * Update aggregation data for a function call.
   *
   * @param functionName - Unique function identifier
   * @param durationNs - Duration in nanoseconds (0 for non-sampled)
   * @param exceptionName - Exception class name if thrown
   * @param caller - Caller function name if known
   * @param isSampled - Whether this call was sampled for timing
   * @param operation - Operation string (pass directly to avoid ALS lookup)
   */
  updateAggregations(
    functionName: string,
    durationNs: number,
    exceptionName?: string,
    caller?: string,
    isSampled: boolean = true,
    operation?: string | null
  ): void {
    // Use provided operation, or fall back to ALS lookup for backward compat
    const effectiveOperation = operation !== undefined ? operation : getCurrentOperation();

    // Fast path: check last-bucket cache (common for repeated calls to same function)
    let agg: AggregationBucket;
    if (
      this._lastBucket !== null &&
      functionName === this._lastFunctionName &&
      effectiveOperation === this._lastOperation
    ) {
      agg = this._lastBucket;
    } else {
      // Cache miss: do the Map lookups
      let operationMap = this._aggregations.get(functionName);
      if (!operationMap) {
        operationMap = new Map();
        this._aggregations.set(functionName, operationMap);
      }

      const found = operationMap.get(effectiveOperation);
      if (found) {
        agg = found;
      } else {
        agg = createAggregationBucket();
        operationMap.set(effectiveOperation, agg);
      }

      // Update cache
      this._lastFunctionName = functionName;
      this._lastOperation = effectiveOperation;
      this._lastBucket = agg;
    }

    // Always update call count
    agg.count += 1;

    if (exceptionName) {
      agg.exceptions.set(exceptionName, (agg.exceptions.get(exceptionName) ?? 0) + 1);
    }

    if (caller) {
      agg.callerMap.set(caller, (agg.callerMap.get(caller) ?? 0) + 1);
    }

    // Only update timing fields for sampled calls
    if (isSampled) {
      agg.sampledCount += 1;
      agg.sumDuration += durationNs;
      agg.sumSquaredDuration += durationNs * durationNs;
      agg.sehHistogram.recordUnsafe(durationNs);
    }
  }

  /**
   * Atomic swap: get current aggregations and replace with empty.
   * Called by FunctionCallCollector on each flush interval.
   */
  getAndSwapAggregations(): Aggregations {
    const current = this._aggregations;
    this._aggregations = new Map();
    // Invalidate last-bucket cache since the old Map is gone
    this._lastBucket = null;
    this._lastFunctionName = '';
    this._lastOperation = undefined;
    return current;
  }

  /** Snapshot of _callCounts at last flush (for computing deltas). */
  private _lastCallCountSnapshot: Record<string, number> = Object.create(null);

  /**
   * Get the delta of call counters since last flush.
   * Does NOT reset _callCounts — those are cumulative and used by sampling.
   */
  getCallCountDeltas(): Record<string, number> {
    const deltas: Record<string, number> = {};
    for (const key of Object.keys(_callCounts)) {
      const current = _callCounts[key];
      const last = this._lastCallCountSnapshot[key] || 0;
      const delta = current - last;
      if (delta > 0) {
        deltas[key] = delta;
      }
      this._lastCallCountSnapshot[key] = current;
    }
    return deltas;
  }

  /** Start capturing investigation data for the current request. */
  beginInvestigation(): void {
    _investigationActiveCount++;
    investigationStorage.enterWith({
      callPath: [],
      exception: null,
      startTime: Date.now(),
    });
  }

  /** Get and clear investigation data. */
  getInvestigationData(): InvestigationData | null {
    const data = investigationStorage.getStore() ?? null;
    investigationStorage.enterWith(null);
    if (_investigationActiveCount > 0) {
      _investigationActiveCount--;
    }
    return data;
  }

  /** Peek at investigation data WITHOUT clearing it. */
  peekInvestigationData(): InvestigationData | null {
    return investigationStorage.getStore() ?? null;
  }

  /**
   * Record a function call with timing information for investigation.
   */
  recordCallPathEntry(functionName: string, caller: string | null, durationNs: number): void {
    const invData = investigationStorage.getStore();
    if (invData) {
      invData.callPath.push({
        functionName,
        callerFunctionName: caller,
        durationNs,
      });
    }
  }
}

// ============================================================================
// Monitor Context (returned by __serviceeventsMonitorEnter)
// ============================================================================

export interface MonitorContext {
  functionName: string;
  startTime: number; // performance.now() result in milliseconds (only valid when sampled)
  caller: string | null;
  isSampled: boolean;
  exceptionName: string | null;
  /**
   * Source line of the function definition, resolved from the function
   * registry at enter-time. Cached on the context so the hot exit path
   * doesn't re-lookup; undefined when the function isn't in the registry
   * (anonymous/dynamically generated code paths).
   */
  functionLine: number | undefined;
  /** Whether the function is declared `async`, cached at enter-time. */
  isAsync: boolean;
}

// ============================================================================
// Context Pool (avoids GC pressure from allocating MonitorContext per call)
// ============================================================================

/**
 * Pre-allocated pool of MonitorContext objects.
 * At 2000 TPS with ~11 functions per request, we get ~22,000 allocations/sec.
 * The pool eliminates all of this GC pressure.
 *
 * Sizing: full-fidelity aggregation (see __serviceeventsMonitorEnter) takes a pool
 * slot on every non-detached call, not just sampled ones. Effective demand is
 * `max in-flight async requests × avg instrumented call-stack depth`. 2048
 * covers ~186 concurrent requests × ~11 frames; if a slot isn't available we
 * fall through to a fresh literal allocation (graceful but adds GC pressure).
 * Each slot is ~80 B so the pool is ~160 KB resident.
 */
const _POOL_SIZE = 2048;
const _contextPool: MonitorContext[] = [];
let _poolIdx = _POOL_SIZE - 1;

// Pre-allocate pool (all entries available from the start)
for (let i = 0; i < _POOL_SIZE; i++) {
  _contextPool.push({
    functionName: '',
    startTime: 0,
    caller: null,
    isSampled: false,
    exceptionName: null,
    functionLine: undefined,
    isAsync: false,
  });
}

// ============================================================================
// Fast-path Functions (called by AST-injected code)
// ============================================================================

/**
 * Called by AST-injected wrapper for every user function.
 * Handles counter increment, detach check, sampling, and timing.
 * Returns MonitorContext if sampled, null otherwise.
 *
 * Generated AST pattern:
 * ```
 * var __tCtx; try{__tCtx=__tEnter("uuid")}catch(_e){}
 * try { ...body... }
 * catch(__tErr){try{__tCatch(__tCtx,__tErr)}catch(_e){}throw __tErr}
 * finally{try{__tExit(__tCtx)}catch(_e){}}
 * ```
 */
export function __serviceeventsMonitorEnter(functionName: string): MonitorContext | null {
  // No-op once the monitor has been shut down. Transformed code holds captured
  // references to this global, so this guard (not global deletion) is what stops
  // post-shutdown aggregation growth.
  if (!_monitorEnabled) {
    return null;
  }

  // 1. Increment call counter (always, even when detached — for rate detection)
  const callCount = (_callCounts[functionName] = (_callCounts[functionName] || 0) + 1);

  // 2. Detach check — return null immediately when detached
  if (_runningMode === 2) {
    return null;
  }

  // 3. Record caller + push stack on EVERY call (full-fidelity aggregation
  // matches Python/Java: caller_map, call_count, error_count, and incident
  // call_path must reflect every invocation, not only sampled ones).
  const caller = _globalStackIdx >= 0 ? _globalStack[_globalStackIdx] : null;
  const newIdx = ++_globalStackIdx;
  if (newIdx < _globalStack.length) {
    _globalStack[newIdx] = functionName;
  } else {
    _globalStack.push(functionName);
  }

  // 4. Sampling check only gates timing (duration + histogram). Unsampled calls
  // still get a ctx so __serviceeventsMonitorExit can update full aggregation fields.
  const isSampled = shouldSampleFast(callCount);
  const startTime = isSampled ? performance.now() : 0;

  // 5. Cache function metadata (line, async-ness) on sampled calls so the
  // hot exit path can build histogram attributes without a per-call registry
  // lookup. Skipped on unsampled calls because:
  //   - The histogram path is sampled-only.
  //   - The SEH/EMF aggregation path resolves these fields once per flush
  //     (in FunctionCallCollector), not per call, so the lookup is wasted
  //     work for unsampled calls.
  let funcInfo: FunctionRegistryEntry | undefined;
  if (isSampled) {
    funcInfo = getFunctionInfo(functionName);
  }

  // 6. Get context from pool
  const ctx =
    _poolIdx >= 0
      ? _contextPool[_poolIdx--]
      : {
          functionName: '',
          startTime: 0,
          caller: null,
          isSampled: false,
          exceptionName: null,
          functionLine: undefined,
          isAsync: false,
        };
  ctx.functionName = functionName;
  ctx.startTime = startTime;
  ctx.caller = caller;
  ctx.isSampled = isSampled;
  ctx.exceptionName = null;
  ctx.functionLine = typeof funcInfo?.line === 'number' ? funcInfo.line : undefined;
  ctx.isAsync = funcInfo?.isAsync === true;
  return ctx;
}

/**
 * Called when an exception is caught in the AST wrapper. Records the exception
 * name on the context so __serviceeventsMonitorExit can credit it to the function's
 * aggregation bucket, and captures rich traceback data when an investigation
 * is active.
 *
 * Cross-SDK invariant: every frame on the unwinding stack credits the
 * exception. The AST-emitted `catch(err) { __tCatch(ctx, err); throw err }`
 * pattern runs at every instrumented frame the exception propagates through,
 * and each of their aggregation buckets records it — matching Python's
 * `with` __exit__ semantics and Java's ByteBuddy `@Advice.Thrown`. This
 * means FunctionCall.error_count is 'times this function saw an exception
 * during execution (including propagation),' not 'times this function was
 * the throw site.' The originating function is preserved separately in
 * investigation.exception.functionName for IncidentSnapshot.call_path.
 */
export function __serviceeventsMonitorException(ctx: MonitorContext | null, err: unknown): void {
  // No-op after shutdown. A request in-flight when unregisterMonitorGlobals() ran
  // still holds a non-null ctx; without this guard it would keep mutating
  // aggregation state that no collector will drain.
  if (!_monitorEnabled) return;
  if (!ctx) return;

  const name = err instanceof Error ? err.constructor.name || err.name || 'Error' : 'Error';
  ctx.exceptionName = name;

  // Investigation path: preserve rich message + traceback for IncidentSnapshot.
  if (_investigationActiveCount <= 0) {
    return;
  }
  const invData = investigationStorage.getStore();
  if (invData) {
    const message = err instanceof Error ? err.message : String(err);
    const stackTrace = err instanceof Error ? err.stack ?? '' : '';
    invData.exception = {
      name,
      message,
      traceback: stackTrace,
      functionName: ctx.functionName,
    };
  }
}

/**
 * Called in the finally block of every AST-instrumented function.
 * Records duration, updates aggregations, and pops call stack.
 *
 * Performance optimizations:
 * - Unsampled calls with no investigation: just count + stack pop (no ALS lookup!)
 * - Sampled calls (histogram wired): no ALS lookup; histogram.record only
 * - Sampled calls (SEH/EMF fallback): 1 ALS lookup (operation) + aggregation update
 * - Investigation active: +1 ALS lookup (investigationStorage)
 * - Returns context to pool (no GC)
 */
export function __serviceeventsMonitorExit(ctx: MonitorContext | null): void {
  // No-op after shutdown. A request in-flight when unregisterMonitorGlobals() ran
  // still holds a non-null ctx; without this guard it would keep popping the stack
  // and mutating aggregation state that no collector will drain.
  if (!_monitorEnabled) return;
  if (!ctx) return; // Detached mode — no-op
  // Pop from global stack (no ALS lookup) on every call since every call pushed.
  _globalStackIdx--;

  // Duration only valid when sampled; 0 otherwise. updateAggregations gates
  // timing-field updates on isSampled.
  const durationNs = ctx.isSampled ? (performance.now() - ctx.startTime) * 1_000_000 : 0;

  if (_investigationActiveCount > 0) {
    const invData = investigationStorage.getStore();
    if (invData) {
      invData.callPath.push({
        functionName: ctx.functionName,
        callerFunctionName: ctx.caller,
        durationNs,
      });
    }
  }

  const state = _getMonitorState();

  // Histogram wired -> it's the sole function-call signal (sampled calls only;
  // unsampled calls leave no entry, keeping sum/min/percentiles clean).
  // Histogram not wired -> SEH/EMF aggregation path, drained by
  // `FunctionCallCollector` into `aws.service_events.function_call`
  // LogRecords. The two paths are mutually exclusive.
  if (state.hasFunctionDurationHistogram()) {
    state.recordFunctionCallMetrics(
      ctx.functionName,
      durationNs,
      ctx.isSampled,
      ctx.caller ?? undefined,
      ctx.exceptionName ?? undefined,
      ctx.functionLine,
      ctx.isAsync
    );
  } else {
    // ALS lookup is gated to the SEH/EMF path: `updateAggregations` keys its
    // bucket map by operation.
    const operation = operationStorage.getStore() ?? null;
    state.updateAggregations(
      ctx.functionName,
      durationNs,
      ctx.exceptionName ?? undefined,
      ctx.caller ?? undefined,
      ctx.isSampled,
      operation
    );
  }

  // Return context to pool
  if (_poolIdx < _POOL_SIZE - 1) {
    _contextPool[++_poolIdx] = ctx;
  }
}

// ============================================================================
// Global Registration (for CJS + ESM support)
// ============================================================================

/**
 * Register monitor functions on globalThis so AST-transformed code can
 * reference them without a require() or import statement.
 *
 * This enables the same transformed code to work in both CJS and ESM contexts.
 * Must be called before any transformed user code runs.
 */
export function registerMonitorGlobals(): void {
  _monitorEnabled = true;
  (globalThis as any).__serviceeventsMonitorEnter = __serviceeventsMonitorEnter;
  (globalThis as any).__serviceeventsMonitorExit = __serviceeventsMonitorExit;
  (globalThis as any).__serviceeventsMonitorException = __serviceeventsMonitorException;
}

/**
 * Disable the monitor hot path on shutdown. AST-transformed code keeps its captured
 * references to the global functions, so we flip `_monitorEnabled` (making Enter a
 * no-op that returns null, which in turn neutralizes Exit/Exception) rather than
 * relying on deleting the globals. We also delete the globals for cleanliness and so
 * a fresh require()'d module isn't mistaken for an active monitor. Without this,
 * post-shutdown calls keep filling aggregation state that no collector drains,
 * growing memory unbounded and leaking state across tests.
 */
export function unregisterMonitorGlobals(): void {
  _monitorEnabled = false;
  delete (globalThis as any).__serviceeventsMonitorEnter;
  delete (globalThis as any).__serviceeventsMonitorExit;
  delete (globalThis as any).__serviceeventsMonitorException;
}

// ============================================================================
// Reset Function (for testing / worker threads)
// ============================================================================

/**
 * Reset all module state. Primarily for testing.
 */
export function resetMonitorState(): void {
  _samplingMode = 'auto';
  // Fresh state is enabled (matches module-load default); only shutdown disables.
  _monitorEnabled = true;
  // Clear call counters
  for (const key of Object.keys(_callCounts)) {
    delete _callCounts[key];
  }
  // Clear hot operations
  for (const key of Object.keys(_hotOperations)) {
    delete _hotOperations[key];
  }
  // Reset global stack
  _globalStackIdx = -1;
  _globalStack.length = 0;
  // Reset investigation counter
  _investigationActiveCount = 0;
  // Reset context pool
  _poolIdx = _POOL_SIZE - 1;
  // Reset ALS contexts
  operationStorage.enterWith(null);
  investigationStorage.enterWith(null);
  ServiceEventsMonitorState.resetInstance();
  // Reset cached singleton
  _monitorState = null;
}
