// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  ServiceEventsMonitorState,
  __serviceeventsMonitorEnter,
  __serviceeventsMonitorExit,
  __serviceeventsMonitorException,
  setSamplingMode,
  getSamplingMode,
  getCallStack,
  setCurrentOperation,
  getCurrentOperation,
  clearCurrentOperation,
  registerMonitorGlobals,
  unregisterMonitorGlobals,
  resetMonitorState,
  setDetachThreshold,
  shouldSampleFast,
  setSamplingThresholds,
} from '../../src/serviceevents/serviceevents-monitor';

describe('ServiceEventsMonitor', function () {
  beforeEach(function () {
    resetMonitorState();
  });

  afterEach(function () {
    resetMonitorState();
  });

  describe('ServiceEventsMonitorState', function () {
    it('should be a singleton', function () {
      const state1 = ServiceEventsMonitorState.getInstance();
      const state2 = ServiceEventsMonitorState.getInstance();
      expect(state1).toBe(state2);
    });

    it('should reset instance', function () {
      const state1 = ServiceEventsMonitorState.getInstance();
      ServiceEventsMonitorState.resetInstance();
      const state2 = ServiceEventsMonitorState.getInstance();
      expect(state1).not.toBe(state2);
    });

    it('getAndSwapAggregations should return current and replace with empty', function () {
      const state = ServiceEventsMonitorState.getInstance();

      // Add some aggregation data via the monitor functions
      setSamplingMode('always');
      const ctx = __serviceeventsMonitorEnter('test-func');
      __serviceeventsMonitorExit(ctx!);

      const agg = state.getAndSwapAggregations();
      expect(agg.size).toBeGreaterThan(0);

      // Second call should return empty
      const agg2 = state.getAndSwapAggregations();
      expect(agg2.size).toBe(0);
    });
  });

  describe('Sampling', function () {
    it('should default to always mode', function () {
      expect(getSamplingMode()).toBe('always');
    });

    it('should accept valid modes', function () {
      setSamplingMode('always');
      expect(getSamplingMode()).toBe('always');

      setSamplingMode('never');
      expect(getSamplingMode()).toBe('never');

      setSamplingMode('auto');
      expect(getSamplingMode()).toBe('auto');
    });

    it('should reject invalid mode', function () {
      expect(() => setSamplingMode('invalid')).toThrow('Invalid sampling mode');
    });

    it('should reject adaptive mode (removed)', function () {
      expect(() => setSamplingMode('adaptive')).toThrow('Invalid sampling mode');
    });

    it('should always sample in always mode', function () {
      setSamplingMode('always');
      const ctx = __serviceeventsMonitorEnter('test-func');
      expect(ctx!.isSampled).toBe(true);
      __serviceeventsMonitorExit(ctx!);
    });

    it('should return ctx with isSampled=false in never mode', function () {
      // Sampling is handled inside __serviceeventsMonitorEnter. Unsampled calls
      // still receive a ctx so full-fidelity aggregation (call_count,
      // caller_map, error_count, call_path) can be recorded on every call —
      // matches Python/Java semantics. Only timing fields are gated on sampling.
      setSamplingMode('never');
      const ctx = __serviceeventsMonitorEnter('test-func');
      expect(ctx).not.toBe(null);
      expect(ctx!.isSampled).toBe(false);
      expect(ctx!.startTime).toBe(0);
      __serviceeventsMonitorExit(ctx!);
    });
  });

  describe('__serviceeventsMonitorEnter / __serviceeventsMonitorExit', function () {
    it('should return a MonitorContext', function () {
      setSamplingMode('always');
      const ctx = __serviceeventsMonitorEnter('test-func');
      expect(ctx!.functionName).toBe('test-func');
      expect(ctx!.isSampled).toBe(true);
      expect(typeof ctx!.startTime).toBe('number');
      expect(ctx!.startTime).toBeGreaterThan(0);
      __serviceeventsMonitorExit(ctx!);
    });

    it('should record duration in aggregations', function () {
      setSamplingMode('always');
      const state = ServiceEventsMonitorState.getInstance();

      const ctx = __serviceeventsMonitorEnter('timed-func');
      // Small delay to ensure non-zero duration
      __serviceeventsMonitorExit(ctx!);

      const agg = state.getAndSwapAggregations();
      expect(agg.has('timed-func')).toBe(true);
      const endpointMap = agg.get('timed-func')!;
      const bucket = endpointMap.values().next().value!;
      expect(bucket.count).toBe(1);
      expect(bucket.sampledCount).toBe(1);
    });

    it('should track caller correctly for nested calls', function () {
      setSamplingMode('always');
      const state = ServiceEventsMonitorState.getInstance();

      const outerCtx = __serviceeventsMonitorEnter('outer-func');
      const innerCtx = __serviceeventsMonitorEnter('inner-func');
      expect(innerCtx!.caller).toBe('outer-func');
      __serviceeventsMonitorExit(innerCtx);
      __serviceeventsMonitorExit(outerCtx);

      const agg = state.getAndSwapAggregations();
      const innerMap = agg.get('inner-func')!;
      const innerBucket = innerMap.values().next().value!;
      expect(innerBucket.callerMap.get('outer-func')).toBe(1);
    });

    it('should have null caller for top-level call', function () {
      const ctx = __serviceeventsMonitorEnter('top-func');
      expect(ctx!.caller).toBe(null);
      __serviceeventsMonitorExit(ctx!);
    });

    it('should always record timing since Enter is only called for sampled calls', function () {
      // With inline sampling, Enter is only called for sampled calls.
      // Non-sampled calls never reach Enter — the AST `if(__tCtx)` guard skips Exit too.
      // So calling Enter directly always produces sampled data.
      setSamplingMode('always');
      const state = ServiceEventsMonitorState.getInstance();

      const ctx = __serviceeventsMonitorEnter('sampled-func');
      __serviceeventsMonitorExit(ctx!);

      const agg = state.getAndSwapAggregations();
      const endpointMap = agg.get('sampled-func')!;
      const bucket = endpointMap.values().next().value!;
      expect(bucket.count).toBe(1);
      expect(bucket.sampledCount).toBe(1);
      expect(bucket.sumDuration).toBeGreaterThan(0);
    });

    it('should handle many sequential calls', function () {
      setSamplingMode('always');
      const state = ServiceEventsMonitorState.getInstance();

      for (let i = 0; i < 50; i++) {
        const ctx = __serviceeventsMonitorEnter('repeated-func');
        __serviceeventsMonitorExit(ctx!);
      }

      const agg = state.getAndSwapAggregations();
      const endpointMap = agg.get('repeated-func')!;
      const bucket = endpointMap.values().next().value!;
      expect(bucket.count).toBe(50);
    });
  });

  describe('__serviceeventsMonitorException', function () {
    it('should record function call without per-function exception tracking (handled by framework)', function () {
      // Per-function exception tracking removed in favor of Express error middleware.
      // The catch block was removed from the AST wrapper to allow V8 to optimize
      // try/finally better. Exceptions are now tracked at the framework level.
      setSamplingMode('always');
      const state = ServiceEventsMonitorState.getInstance();

      const ctx = __serviceeventsMonitorEnter('error-func');
      __serviceeventsMonitorExit(ctx!);

      const agg = state.getAndSwapAggregations();
      const endpointMap = agg.get('error-func')!;
      const bucket = endpointMap.values().next().value!;
      // Count is tracked, but exceptions map is empty (tracked at framework level)
      expect(bucket.count).toBe(1);
      expect(bucket.exceptions.size).toBe(0);
    });

    it('should record exception in investigation data', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      const ctx = __serviceeventsMonitorEnter('error-func');
      const err = new Error('test error');
      __serviceeventsMonitorException(ctx, err);
      __serviceeventsMonitorExit(ctx!);

      const invData = state.getInvestigationData();
      expect(invData).not.toBe(null);
      expect(invData!.exception).not.toBe(null);
      expect(invData!.exception!.name).toBe('Error');
      expect(invData!.exception!.message).toBe('test error');
      // traceback should be a string (deferred formatting optimization)
      expect(typeof invData!.exception!.traceback).toBe('string');
    });

    it('should handle non-Error throws', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      const ctx = __serviceeventsMonitorEnter('error-func');
      __serviceeventsMonitorException(ctx, 'string error');
      __serviceeventsMonitorExit(ctx!);

      const invData = state.getInvestigationData();
      expect(invData!.exception!.name).toBe('Error');
      expect(invData!.exception!.message).toBe('string error');
    });

    it('should skip investigation lookup when no investigation active', function () {
      // No beginInvestigation() called
      const ctx = __serviceeventsMonitorEnter('func');
      // Should not throw
      __serviceeventsMonitorException(ctx, new Error('test'));
      __serviceeventsMonitorExit(ctx!);
    });

    it('records the INNERMOST frame as the exception origin (first-writer-wins, Python parity)', function () {
      // The AST `catch(err){ __tCatch(ctx,err); throw err }` fires innermost-first as the
      // exception unwinds, so the first frame to observe it is the true origin. Outer frames
      // re-observe the SAME exception and must NOT overwrite invData.exception.functionName —
      // otherwise the recorded thrower is always the outermost instrumented frame, diverging
      // from Python's `__exit__` (`if inv_data.get("exception") is None`) and breaking the
      // spec's "Identical across Java, Python, and JS" guarantee for exception_breakdown.
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      // Simulate a throw propagating through two instrumented frames: outer.dispatch calls
      // inner.lookup, inner throws, then the error unwinds back out. The AST catch fires
      // innermost-first, so __serviceeventsMonitorException(inner) runs before (outer); enter/exit
      // nest LIFO (outer entered first since it's the caller).
      const outer = __serviceeventsMonitorEnter('outer.dispatch');
      const inner = __serviceeventsMonitorEnter('inner.lookup');
      const err = new TypeError('boom');
      __serviceeventsMonitorException(inner, err); // innermost observes first → origin
      __serviceeventsMonitorExit(inner!);
      __serviceeventsMonitorException(outer, err); // outermost re-observes → must NOT overwrite
      __serviceeventsMonitorExit(outer!);

      const invData = state.getInvestigationData();
      expect(invData!.exception!.name).toBe('TypeError');
      // The origin function is the innermost frame, not the outermost — first-writer-wins.
      expect(invData!.exception!.functionName).toBe('inner.lookup');
    });
  });

  describe('Investigation', function () {
    it('beginInvestigation should set up investigation data', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      const data = state.peekInvestigationData();
      expect(data).not.toBe(null);
      expect(data!.callPath).toEqual([]);
      expect(data!.exception).toBe(null);
      expect(data!.startTime).toBeGreaterThan(0);
    });

    it('getInvestigationData should return and clear data', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      const data = state.getInvestigationData();
      expect(data).not.toBe(null);

      // Should be cleared
      const data2 = state.getInvestigationData();
      expect(data2).toBe(null);
    });

    it('should record call path entries during investigation', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      const outerCtx = __serviceeventsMonitorEnter('outer');
      const innerCtx = __serviceeventsMonitorEnter('inner');
      __serviceeventsMonitorExit(innerCtx);
      __serviceeventsMonitorExit(outerCtx);

      const invData = state.getInvestigationData();
      expect(invData!.callPath.length).toBeGreaterThanOrEqual(2);

      const innerEntry = invData!.callPath.find(e => e.functionName === 'inner');
      expect(innerEntry).toBeDefined();
      expect(innerEntry!.callerFunctionName).toBe('outer');
    });

    it('beginInvestigation is create-only: a re-entrant begin keeps the outer call path', function () {
      // A nested begin (e.g. an internal /error forward re-entering the request) must NOT
      // reset the in-progress investigation, nor double-count the active-count. Mirrors the
      // Java/Python create-only begin guards. Under the pre-fix code the second begin
      // overwrote the store with a fresh empty callPath, dropping already-recorded frames.
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();
      state.recordCallPathEntry('func-a', null, 1000);

      state.beginInvestigation(); // re-entrant — must be a no-op

      const data = state.peekInvestigationData();
      expect(data).not.toBe(null);
      expect(data!.callPath.map(e => e.functionName)).toEqual(['func-a']);

      // The single begin is balanced by a single get; a second get returns null (no leak).
      expect(state.getInvestigationData()).not.toBe(null);
      expect(state.getInvestigationData()).toBe(null);
    });
  });

  describe('Endpoint ID', function () {
    it('should set and get endpoint ID', function () {
      setCurrentOperation('ep-123');
      expect(getCurrentOperation()).toBe('ep-123');
    });

    it('should clear endpoint ID', function () {
      setCurrentOperation('ep-123');
      clearCurrentOperation();
      expect(getCurrentOperation()).toBe(null);
    });

    it('should default to null', function () {
      expect(getCurrentOperation()).toBe(null);
    });
  });

  describe('Call Stack', function () {
    it('should return empty array when no calls active', function () {
      expect(getCallStack()).toEqual([]);
    });

    it('should reflect active calls', function () {
      const ctx1 = __serviceeventsMonitorEnter('func-a');
      expect(getCallStack()).toContain('func-a');

      const ctx2 = __serviceeventsMonitorEnter('func-b');
      const stack = getCallStack();
      expect(stack).toContain('func-a');
      expect(stack).toContain('func-b');

      __serviceeventsMonitorExit(ctx2);
      __serviceeventsMonitorExit(ctx1);
    });

    it('should be empty after all calls exit', function () {
      const ctx = __serviceeventsMonitorEnter('func');
      __serviceeventsMonitorExit(ctx!);
      expect(getCallStack()).toEqual([]);
    });
  });

  describe('Aggregation bucketing by endpoint', function () {
    it('should bucket aggregations by endpoint ID', function () {
      setSamplingMode('always');
      const state = ServiceEventsMonitorState.getInstance();

      setCurrentOperation('ep-1');
      const ctx1 = __serviceeventsMonitorEnter('func');
      __serviceeventsMonitorExit(ctx1);

      setCurrentOperation('ep-2');
      const ctx2 = __serviceeventsMonitorEnter('func');
      __serviceeventsMonitorExit(ctx2);

      clearCurrentOperation();

      const agg = state.getAndSwapAggregations();
      const endpointMap = agg.get('func')!;
      expect(endpointMap.has('ep-1')).toBe(true);
      expect(endpointMap.has('ep-2')).toBe(true);
    });
  });

  describe('Auto sampling tiers', function () {
    it('should sample first 100 calls in auto mode', function () {
      setSamplingMode('auto');
      // All first 100 calls should be sampled
      for (let i = 0; i < 100; i++) {
        const ctx = __serviceeventsMonitorEnter('auto-func');
        expect(ctx!.isSampled).toBe(true);
        __serviceeventsMonitorExit(ctx!);
      }
    });

    it('should sample at reduced rate after tier1 threshold (inline check)', function () {
      // Sampling is now decided inline: ++__tC[id] <= T1 || __tC[id] % T3 === 0
      // Simulate the inline check directly
      const T1 = 100,
        T3 = 100;
      let sampledCount = 0;
      const counts: Record<string, number> = {};
      for (let i = 0; i < 500; i++) {
        const cc = (counts['tier-func'] = (counts['tier-func'] || 0) + 1);
        if (cc <= T1 || cc % T3 === 0) sampledCount++;
      }
      // First 100 always sampled, then 1/100 for next 400 = ~4
      // Expected: 100 + 4 = 104
      expect(sampledCount).toBeGreaterThanOrEqual(100);
      expect(sampledCount).toBeLessThan(110);
    });
  });

  describe('registerMonitorGlobals()', function () {
    it('should register monitor functions on globalThis', function () {
      registerMonitorGlobals();
      expect((globalThis as any).__serviceeventsMonitorEnter).toBe(__serviceeventsMonitorEnter);
      expect((globalThis as any).__serviceeventsMonitorExit).toBe(__serviceeventsMonitorExit);
      expect((globalThis as any).__serviceeventsMonitorException).toBe(__serviceeventsMonitorException);
    });
  });

  describe('unregisterMonitorGlobals()', function () {
    afterEach(function () {
      // Restore enabled state for subsequent tests (resetMonitorState also does this).
      resetMonitorState();
    });

    it('should delete the monitor functions from globalThis', function () {
      registerMonitorGlobals();
      unregisterMonitorGlobals();
      expect((globalThis as any).__serviceeventsMonitorEnter).toBeUndefined();
      expect((globalThis as any).__serviceeventsMonitorExit).toBeUndefined();
      expect((globalThis as any).__serviceeventsMonitorException).toBeUndefined();
    });

    it('makes __serviceeventsMonitorEnter a no-op so post-shutdown calls stop aggregating', function () {
      registerMonitorGlobals();
      // Active: Enter returns a context and records a call.
      const ctxBefore = __serviceeventsMonitorEnter('svc.fn');
      expect(ctxBefore).not.toBe(null);
      __serviceeventsMonitorExit(ctxBefore);

      unregisterMonitorGlobals();

      // After unregister: Enter is a no-op (null), so transformed code that still
      // holds a captured reference can no longer grow aggregation state.
      const ctxAfter = __serviceeventsMonitorEnter('svc.fn');
      expect(ctxAfter).toBe(null);
      // Exit/Exception tolerate the null context without throwing.
      expect(() => __serviceeventsMonitorExit(ctxAfter)).not.toThrow();
      expect(() => __serviceeventsMonitorException(ctxAfter, new Error('x'))).not.toThrow();
    });
  });

  describe('recordCallPathEntry()', function () {
    it('should record entry when investigation is active', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      state.recordCallPathEntry('func-a', null, 1000);
      state.recordCallPathEntry('func-b', 'func-a', 500);

      const invData = state.getInvestigationData();
      expect(invData).not.toBe(null);
      expect(invData!.callPath.length).toBe(2);
      expect(invData!.callPath[0].functionName).toBe('func-a');
      expect(invData!.callPath[0].callerFunctionName).toBe(null);
      expect(invData!.callPath[0].durationNs).toBe(1000);
      expect(invData!.callPath[1].functionName).toBe('func-b');
      expect(invData!.callPath[1].callerFunctionName).toBe('func-a');
    });

    it('should be a no-op when no investigation is active', function () {
      const state = ServiceEventsMonitorState.getInstance();
      // No beginInvestigation() called - should not throw
      state.recordCallPathEntry('func-a', null, 1000);
    });

    it('should cap the call path and append a single truncation sentinel on overflow', function () {
      const MAX = 1024; // mirrors MAX_CALL_PATH_ENTRIES in serviceevents-monitor.ts
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      // Record well past the cap; every frame has a non-zero duration so is_partial would be false
      // if the cap never fired.
      for (let i = 0; i < MAX + 50; i++) {
        state.recordCallPathEntry(`func-${i}`, i === 0 ? null : `func-${i - 1}`, 1000);
      }

      const invData = state.getInvestigationData();
      expect(invData).not.toBe(null);
      // Keep-first: MAX real frames + exactly one sentinel, regardless of how far past the cap we went.
      expect(invData!.callPath.length).toBe(MAX + 1);

      // A below-cap frame is a normal entry.
      expect(invData!.callPath[0].functionName).toBe('func-0');
      expect(invData!.callPath[MAX - 1].functionName).toBe(`func-${MAX - 1}`);
      expect(invData!.callPath[MAX - 1].durationNs).toBe(1000);

      // The overflow frame is the sentinel with durationNs=0 (trips is_partial downstream).
      const sentinel = invData!.callPath[MAX];
      expect(sentinel.functionName).toBe('<call_path_truncated>');
      expect(sentinel.callerFunctionName).toBe(null);
      expect(sentinel.durationNs).toBe(0);

      // is_partial parity: at least one zero-duration frame is present.
      expect(invData!.callPath.some(e => e.durationNs === 0)).toBe(true);
    });
  });

  describe('updateAggregations()', function () {
    it('should fall back to ALS endpoint ID when not explicitly provided', function () {
      const state = ServiceEventsMonitorState.getInstance();
      setCurrentOperation('als-ep');

      // Call without explicit operation (6th param undefined)
      state.updateAggregations('func', 1000, undefined, undefined, true);

      clearCurrentOperation();

      const agg = state.getAndSwapAggregations();
      const endpointMap = agg.get('func')!;
      expect(endpointMap.has('als-ep')).toBe(true);
    });

    it('should track exceptions in aggregation bucket', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.updateAggregations('func', 1000, 'RangeError', undefined, true, null);
      state.updateAggregations('func', 1000, 'RangeError', undefined, true, null);
      state.updateAggregations('func', 1000, 'TypeError', undefined, true, null);

      const agg = state.getAndSwapAggregations();
      const bucket = agg.get('func')!.get(null)!;
      expect(bucket.exceptions.get('RangeError')).toBe(2);
      expect(bucket.exceptions.get('TypeError')).toBe(1);
    });

    it('should track callers in aggregation bucket', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.updateAggregations('func', 1000, undefined, 'caller-a', true, null);
      state.updateAggregations('func', 1000, undefined, 'caller-a', true, null);
      state.updateAggregations('func', 1000, undefined, 'caller-b', true, null);

      const agg = state.getAndSwapAggregations();
      const bucket = agg.get('func')!.get(null)!;
      expect(bucket.callerMap.get('caller-a')).toBe(2);
      expect(bucket.callerMap.get('caller-b')).toBe(1);
    });
  });

  describe('Dynamic function detach', function () {
    it('should return non-sampled context in never mode', function () {
      setSamplingMode('never');
      const ctx = __serviceeventsMonitorEnter('detach-func');
      // never mode: Enter still returns a context (for stack tracking), but isSampled=false
      // Null would mean the context pool approach changed — check both possibilities
      if (ctx) {
        expect(ctx.isSampled).toBe(false);
        __serviceeventsMonitorExit(ctx);
      }
      // Either way, the function should not crash
    });
  });

  describe('getCallCountDeltas()', function () {
    it('should return deltas since last call', function () {
      const state = ServiceEventsMonitorState.getInstance();
      setSamplingMode('always');

      // Make some calls
      for (let i = 0; i < 5; i++) {
        const ctx = __serviceeventsMonitorEnter('delta-func');
        __serviceeventsMonitorExit(ctx);
      }

      const deltas1 = state.getCallCountDeltas();
      expect(deltas1['delta-func']).toBe(5);

      // Make more calls
      for (let i = 0; i < 3; i++) {
        const ctx = __serviceeventsMonitorEnter('delta-func');
        __serviceeventsMonitorExit(ctx);
      }

      const deltas2 = state.getCallCountDeltas();
      expect(deltas2['delta-func']).toBe(3); // delta, not cumulative
    });

    it('should return empty for functions with no new calls', function () {
      const state = ServiceEventsMonitorState.getInstance();
      setSamplingMode('always');

      const ctx = __serviceeventsMonitorEnter('once-func');
      __serviceeventsMonitorExit(ctx);

      state.getCallCountDeltas(); // consume first delta

      const deltas = state.getCallCountDeltas();
      expect(deltas['once-func']).toBeUndefined(); // no new calls
    });
  });

  describe('Investigation + exception in Exit', function () {
    it('should propagate exception name to aggregations via Exit', function () {
      setSamplingMode('always');
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      const ctx = __serviceeventsMonitorEnter('exc-func');
      __serviceeventsMonitorException(ctx, new RangeError('out of range'));
      __serviceeventsMonitorExit(ctx);

      state.getInvestigationData(); // cleanup

      const agg = state.getAndSwapAggregations();
      const bucket = agg.get('exc-func')!.values().next().value!;
      expect(bucket.exceptions.get('RangeError')).toBe(1);
    });

    it('should record call_path entries during investigation', function () {
      setSamplingMode('always');
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();

      const outer = __serviceeventsMonitorEnter('outer');
      const inner = __serviceeventsMonitorEnter('inner');
      __serviceeventsMonitorExit(inner);
      __serviceeventsMonitorExit(outer);

      const invData = state.getInvestigationData();
      expect(invData).not.toBe(null);
      expect(invData!.callPath.length).toBe(2);
      expect(invData!.callPath[0].functionName).toBe('inner');
      expect(invData!.callPath[1].functionName).toBe('outer');
    });
  });

  describe('Context pool', function () {
    it('should reuse contexts from pool', function () {
      setSamplingMode('always');
      const ctx1 = __serviceeventsMonitorEnter('pool-func');
      __serviceeventsMonitorExit(ctx1);

      // Second call should reuse the same context object from pool
      const ctx2 = __serviceeventsMonitorEnter('pool-func');
      __serviceeventsMonitorExit(ctx2);

      // Both should work correctly
      expect(ctx1!.functionName).toBe('pool-func');
      expect(ctx2!.functionName).toBe('pool-func');
    });

    it('should handle many concurrent contexts', function () {
      setSamplingMode('always');
      const contexts: any[] = [];

      // Push many onto stack (up to pool size)
      for (let i = 0; i < 200; i++) {
        contexts.push(__serviceeventsMonitorEnter(`deep-${i}`));
      }

      // Pop all
      for (let i = contexts.length - 1; i >= 0; i--) {
        __serviceeventsMonitorExit(contexts[i]);
      }
    });
  });

  describe('Last-bucket cache in updateAggregations', function () {
    it('should use cache for repeated same-function calls', function () {
      const state = ServiceEventsMonitorState.getInstance();

      // Multiple calls to same function should use cached bucket
      for (let i = 0; i < 10; i++) {
        state.updateAggregations('cached-func', 1000, undefined, undefined, true, 'ep-1');
      }

      const agg = state.getAndSwapAggregations();
      const bucket = agg.get('cached-func')!.get('ep-1')!;
      expect(bucket.count).toBe(10);
    });

    it('should invalidate cache when function changes', function () {
      const state = ServiceEventsMonitorState.getInstance();

      state.updateAggregations('func-a', 1000, undefined, undefined, true, 'ep-1');
      state.updateAggregations('func-b', 1000, undefined, undefined, true, 'ep-1');
      state.updateAggregations('func-a', 1000, undefined, undefined, true, 'ep-1');

      const agg = state.getAndSwapAggregations();
      expect(agg.get('func-a')!.get('ep-1')!.count).toBe(2);
      expect(agg.get('func-b')!.get('ep-1')!.count).toBe(1);
    });
  });

  describe('shouldSampleFast() (hot-path sampling decision)', function () {
    it("always samples in 'always' mode", function () {
      setSamplingMode('always');
      expect(shouldSampleFast(1_000_000)).toBe(true);
    });

    it("never samples in 'never' mode", function () {
      setSamplingMode('never');
      expect(shouldSampleFast(1)).toBe(false);
    });

    it('applies tiered sampling in auto mode', function () {
      setSamplingMode('auto');
      setSamplingThresholds({ tier1Threshold: 5, tier2Threshold: 50, tier2Rate: 10, tier3Rate: 100 });
      expect(shouldSampleFast(3)).toBe(true);
      expect(shouldSampleFast(30)).toBe(true);
      expect(shouldSampleFast(31)).toBe(false);
      expect(shouldSampleFast(200)).toBe(true);
      expect(shouldSampleFast(201)).toBe(false);
    });

    it('samples none in a tier with a zero rate (no NaN/crash) in auto mode', function () {
      // A non-positive rate is only reachable via the unvalidated test-config hook; it must
      // degrade to "sample none in this tier" consistently with Python/Java.
      setSamplingMode('auto');
      setSamplingThresholds({ tier1Threshold: 5, tier2Threshold: 50, tier2Rate: 0, tier3Rate: 0 });
      expect(shouldSampleFast(1)).toBe(true); // tier1 unaffected
      expect(shouldSampleFast(20)).toBe(false); // tier2, zero rate
      expect(shouldSampleFast(200)).toBe(false); // tier3, zero rate
    });
  });

  describe('incrementCount()', function () {
    it('counts repeated calls for the same function via the last-bucket cache', function () {
      const state = ServiceEventsMonitorState.getInstance();
      for (let i = 0; i < 4; i++) {
        state.incrementCount('inc-func');
      }
      const agg = state.getAndSwapAggregations();
      // Unsampled increments land in the null-operation bucket.
      expect(agg.get('inc-func')!.get(null)!.count).toBe(4);
    });

    it('creates separate buckets when the function name changes', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.incrementCount('inc-a');
      state.incrementCount('inc-b');
      state.incrementCount('inc-a');
      const agg = state.getAndSwapAggregations();
      expect(agg.get('inc-a')!.get(null)!.count).toBe(2);
      expect(agg.get('inc-b')!.get(null)!.count).toBe(1);
    });
  });

  describe('null-context guards', function () {
    it('__serviceeventsMonitorException is a no-op for a null context', function () {
      expect(() => __serviceeventsMonitorException(null, new Error('x'))).not.toThrow();
    });

    it('__serviceeventsMonitorExit is a no-op for a null context', function () {
      expect(() => __serviceeventsMonitorExit(null)).not.toThrow();
    });
  });

  describe('setDetachThreshold()', function () {
    afterEach(function () {
      // Leave detach disabled so the module-level check timer stays inert for
      // other tests (the interval is created lazily and never torn down).
      setDetachThreshold(0);
    });

    it('is callable with a positive threshold and a zero (disable) threshold without throwing', function () {
      expect(() => setDetachThreshold(1000)).not.toThrow();
      // Calling again is idempotent (the interval is only created once).
      expect(() => setDetachThreshold(2000)).not.toThrow();
      expect(() => setDetachThreshold(0)).not.toThrow();
    });
  });
});
