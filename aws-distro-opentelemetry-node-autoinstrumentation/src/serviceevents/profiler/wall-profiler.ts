// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin wrapper around @datadog/pprof's wall-clock profiler.
 *
 * @datadog/pprof ships as an OPTIONAL dependency. If the prebuilt binary is
 * not available for the current platform, require() throws — we catch that
 * and return a disabled profiler so the rest of ServiceEvents keeps working.
 *
 * API:
 *   const p = new WallProfiler({intervalMicros, withContexts, useCPED});
 *   if (!p.tryStart()) { /* unavailable; skip *\/ }
 *   const profile = p.rotate(); // returns SerializedProfile or null
 *   p.stop();
 */

import { diag } from '@opentelemetry/api';
import { initProfilerContext, getHolder, ProfilerContextHolder } from './profiler-context';

export interface WallProfilerOptions {
  intervalMicros: number;
  withContexts?: boolean;
  useCPED?: boolean;
}

/** Stand-in for the @datadog/pprof serialized profile shape.
 *
 * Real @datadog/pprof returns a `pprof-format` Profile where numeric fields
 * may be number OR bigint, and `stringTable` is a `StringTable` class with a
 * `.strings` array. Our unit tests pass a plain-object fixture (all numbers,
 * `stringTable` as string[]). Types accept both forms so the converter
 * survives real pprof output. */
type Numeric = number | bigint;
export interface SerializedProfile {
  sampleType?: Array<{ type?: Numeric; unit?: Numeric }>;
  sample?: Array<{
    locationId?: Numeric[];
    value?: Numeric[];
    label?: Array<{ key?: Numeric; str?: Numeric; num?: Numeric; numUnit?: Numeric }>;
  }>;
  location?: Array<{
    id?: Numeric;
    mappingId?: Numeric;
    address?: Numeric;
    line?: Array<{ functionId?: Numeric; line?: Numeric }>;
  }>;
  function?: Array<{
    id?: Numeric;
    name?: Numeric;
    systemName?: Numeric;
    filename?: Numeric;
    startLine?: Numeric;
  }>;
  stringTable?: string[] | { strings: string[] };
  timeNanos?: Numeric;
  durationNanos?: Numeric;
}

/** Shape of the @datadog/pprof `generateLabels` callback input.
 *
 * pprof invokes generateLabels once per sample with the node + a context
 * ENTRY (NOT the raw JS context). The entry is `{context, timestamp, cpuTime,
 * asyncId}` where `.context` is the JS object we passed to `setContext()`. */
interface GenerateLabelsArgs {
  node?: unknown;
  context?: {
    context?: ProfilerContextHolder | null;
    timestamp?: number | bigint;
    cpuTime?: number;
    asyncId?: number;
  };
}

export class WallProfiler {
  private opts: WallProfilerOptions;
  private pprofTime: any | null = null;
  private _started: boolean = false;

  constructor(opts: WallProfilerOptions) {
    this.opts = opts;
  }

  /**
   * Load @datadog/pprof (optional dep) and start the profiler.
   * Returns true on success; false if the native dep is unavailable or
   * start() throws.
   */
  tryStart(): boolean {
    if (this._started) return true;

    let pprofModule: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pprofModule = require('@datadog/pprof');
    } catch (err) {
      diag.warn(`ServiceEvents profiler: @datadog/pprof not available (${(err as Error).message}); profiler disabled`);
      return false;
    }
    const time = pprofModule?.time;
    if (!time || typeof time.start !== 'function' || typeof time.stop !== 'function') {
      diag.warn('ServiceEvents profiler: @datadog/pprof loaded but time.start/stop missing; profiler disabled');
      return false;
    }

    // @datadog/pprof rejects useCPED on Node < 22 (CPED / AsyncContextFrame
    // only lands with node:async_hooks' AsyncLocalStorage.enterWith fast path
    // in v22). Auto-detect so we don't have to plumb it from config.
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    const useCPED = this.opts.useCPED ?? nodeMajor >= 22;
    try {
      time.start({
        intervalMicros: this.opts.intervalMicros,
        withContexts: this.opts.withContexts ?? true,
        useCPED,
        collectCpuTime: false,
      });
    } catch (err) {
      diag.warn(`ServiceEvents profiler: pprof.time.start failed (${(err as Error).message}); profiler disabled`);
      return false;
    }

    this.pprofTime = time;
    this._started = true;

    // Wire context holder so subsequent setProfilerSeq() calls are visible to pprof.
    // CPED mode: pprof snapshots the holder per async chain — cheap mutation suffices.
    // Non-CPED: setContext is a single shared slot, so setProfilerSeq must call
    // setContext(fresh obj) each time (see profiler-context.ts).
    try {
      initProfilerContext((ctx: unknown) => time.setContext(ctx), useCPED);
    } catch (err) {
      diag.debug(
        `ServiceEvents profiler: setContext wiring failed (${(err as Error).message}); context labels disabled`
      );
    }

    return true;
  }

  /**
   * Stop the current window and restart a fresh one. Returns the just-
   * completed profile, or null if the profiler isn't running.
   * Each sample gets a `seq` string label from the current holder value.
   */
  rotate(): SerializedProfile | null {
    if (!this._started || !this.pprofTime) return null;
    try {
      const profile: SerializedProfile = this.pprofTime.stop(
        /* restart */ true,
        (args: GenerateLabelsArgs) => this._generateLabels(args),
        /* lowCardinalityLabels */ []
      );
      return profile ?? null;
    } catch (err) {
      diag.debug(`ServiceEvents profiler: rotate failed (${(err as Error).message})`);
      return null;
    }
  }

  stop(): void {
    if (!this._started || !this.pprofTime) return;
    try {
      this.pprofTime.stop(/* restart */ false);
    } catch (err) {
      diag.debug(`ServiceEvents profiler: stop failed (${(err as Error).message})`);
    }
    this._started = false;
  }

  isStarted(): boolean {
    return this._started;
  }

  private _generateLabels(args: GenerateLabelsArgs): Record<string, string | number> {
    // pprof passes `{node, context}` where `context` is a SAMPLE-CONTEXT
    // entry of shape `{context, timestamp, cpuTime, asyncId}`, and the inner
    // `.context` is the JS object we set via `setContext()`. Fall back to
    // the global holder when pprof's sample has no attached context (can
    // happen on the "unlabelled hits" path, serializer line 348).
    const ctxEntry = args?.context;
    const jsContext = ctxEntry?.context ?? getHolder();
    const seq = jsContext?.ref?.seq;
    if (typeof seq === 'number') return { seq: String(seq) };
    return {};
  }
}
