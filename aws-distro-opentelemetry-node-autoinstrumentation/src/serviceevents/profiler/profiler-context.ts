// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-sample context tracker for the profiler.
 *
 * Two modes, transparently selected based on whether pprof was started with
 * `useCPED=true` (only available on Node >= 22):
 *
 *  - **Holder (fast path, CPED on):** One mutable object is registered once
 *    via `setContext(holder)`. Each async chain captures its own holder state
 *    at context-switch boundaries, so mutating `holder.ref` affects only the
 *    current chain. Zero native FFI calls per request.
 *
 *  - **Direct (safe path, CPED off):** `setContext({seq})` is called with a
 *    fresh object on every request arrival and again on response-end (to
 *    clear). Samples captured between those two calls snapshot the {seq}
 *    object by reference, and because each request gets a new object, stale
 *    mutations don't leak. One native FFI call per request boundary.
 *
 * The holder interface is exposed both for unit-test inspection and because
 * `generateLabels` needs a uniform way to read the seq regardless of mode.
 */

export interface ProfilerContextRef {
  seq: number;
}

export interface ProfilerContextHolder {
  ref: ProfilerContextRef | null;
}

/**
 * When `useCPED=true`, pprof gives each async chain its own holder snapshot
 * on context-switch, so mutating `_holder.ref` only affects the current
 * chain's samples. When `useCPED=false`, all samples share `gProfiler.context`,
 * so we call `setContext({seq})` directly with a FRESH object each request —
 * that way samples capture a snapshot-by-reference that doesn't get mutated.
 */
const _holder: ProfilerContextHolder = { ref: null };
let _pprofSetContext: ((ctx: unknown) => void) | null = null;
let _useHolder: boolean = true;

/**
 * Wire a pprof.time.setContext function into the module. Called once by
 * WallProfiler during start(). Passing null resets the binding (for tests).
 *
 * @param setContext The pprof.time.setContext function, or null to unbind.
 * @param useHolder  true if the profiler is running with useCPED=true (per-
 *                   async-chain snapshots). false otherwise — then we must
 *                   allocate a fresh {seq} object per setContext call.
 */
export function initProfilerContext(setContext: ((ctx: unknown) => void) | null, useHolder: boolean = true): void {
  _pprofSetContext = setContext;
  _useHolder = useHolder;
  if (_pprofSetContext && _useHolder) {
    // CPED on: register the holder once; subsequent updates mutate holder.ref.
    _pprofSetContext(_holder);
  }
  // CPED off: defer — setContext fires per request.
}

/**
 * Stamp the per-sample context with a request seq.
 *
 * - CPED on  → cheap holder mutation (one JS write).
 * - CPED off → setContext({seq}) — one native FFI call per request.
 */
export function setProfilerSeq(seq: number): void {
  _holder.ref = { seq };
  if (!_useHolder && _pprofSetContext) {
    // Fresh object per request so pprof can snapshot by reference without
    // later mutation polluting earlier samples.
    _pprofSetContext({ ref: { seq } });
  }
}

/**
 * Clear the per-sample context. Use after response-end so samples taken
 * outside any in-flight request don't carry a stale seq.
 */
export function clearProfilerSeq(): void {
  _holder.ref = null;
  if (!_useHolder && _pprofSetContext) {
    _pprofSetContext({ ref: null });
  }
}

/**
 * Return the latest seq stamped on the holder (or undefined if unset).
 * Used by the generateLabels callback in wall-profiler.ts.
 */
export function getHolder(): ProfilerContextHolder {
  return _holder;
}

/**
 * Reset all context state (for tests).
 */
export function resetProfilerContext(): void {
  _holder.ref = null;
  _pprofSetContext = null;
  _useHolder = true;
}
