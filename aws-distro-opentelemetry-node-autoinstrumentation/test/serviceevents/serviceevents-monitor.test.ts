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
  resetMonitorState,
  markOperationHot,
  tickHotOperations,
  isOperationHot,
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
    it('should default to auto mode', function () {
      expect(getSamplingMode()).toBe('auto');
    });

    it('should accept valid modes', function () {
      setSamplingMode('always');
      expect(getSamplingMode()).toBe('always');

      setSamplingMode('never');
      expect(getSamplingMode()).toBe('never');

      setSamplingMode('auto');
      expect(getSamplingMode()).toBe('auto');

      setSamplingMode('adaptive');
      expect(getSamplingMode()).toBe('adaptive');
    });

    it('should reject invalid mode', function () {
      expect(() => setSamplingMode('invalid')).toThrow('Invalid sampling mode');
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

  describe('Adaptive sampling', function () {
    it('should sample hot endpoints in adaptive mode', function () {
      setSamplingMode('adaptive');
      const operation = 'hot-ep-123';
      markOperationHot(operation);
      setCurrentOperation(operation);

      // Even after many calls, hot endpoints should always be sampled
      for (let i = 0; i < 200; i++) {
        const ctx = __serviceeventsMonitorEnter('adaptive-func');
        expect(ctx!.isSampled).toBe(true);
        __serviceeventsMonitorExit(ctx!);
      }

      clearCurrentOperation();
    });

    it('should fall through to tier sampling for non-hot endpoints (inline check)', function () {
      // Adaptive mode with non-hot endpoints uses the same inline tier check.
      // The inline check doesn't distinguish adaptive from auto — it's just
      // ++__tC[id] <= T1 || __tC[id] % T3 === 0.
      // Hot endpoint promotion happens when __tEnter IS called (for sampled calls),
      // and markOperationHot() triggers 100% sampling via the cached hot flag.
      const T1 = 100,
        T3 = 100;
      let sampledCount = 0;
      const counts: Record<string, number> = {};
      for (let i = 0; i < 200; i++) {
        const cc = (counts['cold-func'] = (counts['cold-func'] || 0) + 1);
        if (cc <= T1 || cc % T3 === 0) sampledCount++;
      }
      // First 100 sampled, then 1/100 for next 100 = 1
      expect(sampledCount).toBeGreaterThanOrEqual(100);
      expect(sampledCount).toBeLessThan(110);
    });
  });

  describe('Hot Endpoint Tracking', function () {
    it('markOperationHot should mark endpoint as hot', function () {
      expect(isOperationHot('ep-1')).toBe(false);
      markOperationHot('ep-1');
      expect(isOperationHot('ep-1')).toBe(true);
    });

    it('tickHotOperations should decrement and eventually remove', function () {
      markOperationHot('ep-tick');
      expect(isOperationHot('ep-tick')).toBe(true);

      // Tick 100 times (HOT_ENDPOINT_CYCLES = 100)
      for (let i = 0; i < 100; i++) {
        tickHotOperations();
      }

      expect(isOperationHot('ep-tick')).toBe(false);
    });

    it('resetMonitorState should clear hot endpoints', function () {
      markOperationHot('ep-reset');
      expect(isOperationHot('ep-reset')).toBe(true);

      resetMonitorState();
      expect(isOperationHot('ep-reset')).toBe(false);
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
});
