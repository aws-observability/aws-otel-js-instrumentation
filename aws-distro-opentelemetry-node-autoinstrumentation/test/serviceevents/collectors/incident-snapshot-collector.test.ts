// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import {
  IncidentSnapshotCollector,
  RequestData,
} from '../../../src/serviceevents/collectors/incident-snapshot-collector';
import { ServiceEventsMonitorState, resetMonitorState } from '../../../src/serviceevents/serviceevents-monitor';
import { ServiceEventsOtlpEmitter } from '../../../src/serviceevents/exporter/otlp-emitter';
import { IncidentSnapshot } from '../../../src/serviceevents/models/incident-telemetry';
import { calculateFunctionName, clearFunctionRegistry } from '../../../src/serviceevents/ast-transformation';

class CaptureEmitter extends ServiceEventsOtlpEmitter {
  snapshots: IncidentSnapshot[] = [];
  constructor() {
    super({ serviceName: 'svc', environment: 'env' });
  }
  override emitIncidentSnapshot(snap: IncidentSnapshot): void {
    this.snapshots.push(snap);
  }
}

function makeRequestData(overrides?: Partial<RequestData>): RequestData {
  // Empty by default — the collector's only correlation source is trace_id/span_id (set by tests
  // that need it). `headers` is not part of RequestData and is ignored; the "headers are ignored"
  // test still passes one via override through the index signature to prove exactly that.
  return {
    ...overrides,
  };
}

describe('IncidentSnapshotCollector (OTLP)', function () {
  let collector: IncidentSnapshotCollector;
  let emitter: CaptureEmitter;

  beforeEach(function () {
    resetMonitorState();
    emitter = new CaptureEmitter();
    collector = new IncidentSnapshotCollector(600_000, 5000, 2500, 'test-env', 'test-svc', '0.0.1', 30, emitter, null);
  });

  afterEach(function () {
    try {
      collector.stop();
    } catch {
      // Ignore
    }
    resetMonitorState();
  });

  it('triggers snapshot on 500 status', function () {
    const exemplar = collector.processPotentialIncident(
      '/api/x',
      'POST',
      500,
      50,
      new Error('boom'),
      makeRequestData()
    );
    expect(exemplar).not.toBeNull();
  });

  it('skips snapshot for 2xx success', function () {
    const exemplar = collector.processPotentialIncident('/api/x', 'GET', 200, 50, null, makeRequestData());
    expect(exemplar).toBeNull();
  });

  it('emits snapshot via OTLP on collect', function () {
    collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
    collector.collect();
    expect(emitter.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(emitter.snapshots[0].trigger_type).toBe('exception');
  });

  it('truncates an oversized exception message and stack trace', function () {
    const hugeMsg = 'x'.repeat(5000); // > MAX_EXCEPTION_MESSAGE_CHARS (2048)
    const err = new Error(hugeMsg);
    err.stack = 'y'.repeat(20000); // > MAX_STACK_TRACE_CHARS (8192)
    collector.processPotentialIncident('/api/x', 'POST', 500, 50, err, makeRequestData());
    collector.collect();
    const info = emitter.snapshots[0].exception_info[0];
    expect(info.exception_message.length).toBeLessThan(hugeMsg.length);
    expect(info.exception_message).toContain('truncated');
    expect(info.stack_trace.length).toBeLessThan(20000);
    expect(info.stack_trace).toContain('truncated');
  });

  it('never emits request payload fields (body/query/path/headers)', function () {
    // Request-payload capture was removed. The snapshot request_context must carry
    // only the non-PII envelope — never the request body, query/path params, or
    // request headers — regardless of what the framework hook passes in.
    collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
    collector.collect();
    const snap = emitter.snapshots[0];
    expect(snap.request_context.request_body).toBeUndefined();
    expect(snap.request_context.query_params).toBeUndefined();
    expect(snap.request_context.path_params).toBeUndefined();
    expect(snap.request_context.request_headers).toBeUndefined();
    expect(snap.request_context.custom_context).toEqual({});
    expect(snap.request_context.type).toBe('http');
    expect(snap.request_context.status_code).toBe(500);
  });

  it('telemetry_correlation has no session_id or request_id', function () {
    collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
    collector.collect();
    const snap = emitter.snapshots[0];
    const corr = snap.telemetry_correlation as unknown as Record<string, unknown>;
    expect(corr.session_id).toBeUndefined();
    expect(corr.request_id).toBeUndefined();
  });

  it('records call_path with function_name (not UUID)', function () {
    const state = ServiceEventsMonitorState.getInstance();
    state.beginInvestigation();
    state.recordCallPathEntry('app.foo', 'app.bar', 1000);
    collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
    collector.collect();
    const snap = emitter.snapshots[0];
    const callPath = snap.exception_info[0]?.call_path ?? [];
    expect(callPath.length).toBeGreaterThan(0);
    expect(callPath[0].function_name).toBe('app.foo');
    expect(callPath[0].caller_function_name).toBe('app.bar');
  });

  // is_partial semantics — match Python's `any(duration_ns == 0)` rule.
  it('is_partial is false when all call_path entries have timing data', function () {
    const state = ServiceEventsMonitorState.getInstance();
    state.beginInvestigation();
    state.recordCallPathEntry('app.a', null, 1000);
    state.recordCallPathEntry('app.b', 'app.a', 2000);
    collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
    collector.collect();
    expect(emitter.snapshots[0].is_partial).toBe(false);
  });

  it('is_partial is true when ANY call_path entry has zero duration (not only when ALL are zero)', function () {
    const state = ServiceEventsMonitorState.getInstance();
    state.beginInvestigation();
    // First entry has timing; second does not — spec/Python say this is partial.
    state.recordCallPathEntry('app.a', null, 1500);
    state.recordCallPathEntry('app.b', 'app.a', 0);
    collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
    collector.collect();
    expect(emitter.snapshots[0].is_partial).toBe(true);
  });

  it('is_partial is true when all call_path entries have zero duration', function () {
    const state = ServiceEventsMonitorState.getInstance();
    state.beginInvestigation();
    state.recordCallPathEntry('app.a', null, 0);
    state.recordCallPathEntry('app.b', 'app.a', 0);
    collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
    collector.collect();
    expect(emitter.snapshots[0].is_partial).toBe(true);
  });

  describe('trigger and severity branches', function () {
    it('triggers exception snapshot on 5xx with no Error object', function () {
      const exemplar = collector.processPotentialIncident('/api/x', 'GET', 503, 10, null, makeRequestData());
      expect(exemplar).not.toBeNull();
      expect(exemplar!.trigger_type).toBe('exception');
      expect(exemplar!.severity).toBe('critical');
    });

    it('severity is high for 5xx >= 504', function () {
      const exemplar = collector.processPotentialIncident('/api/x', 'GET', 504, 10, null, makeRequestData());
      expect(exemplar).not.toBeNull();
      expect(exemplar!.severity).toBe('high');
    });

    it('latency trigger has medium severity', function () {
      const exemplar = collector.processPotentialIncident('/api/slow', 'GET', 200, 6000, null, makeRequestData());
      expect(exemplar).not.toBeNull();
      expect(exemplar!.trigger_type).toBe('latency');
      expect(exemplar!.severity).toBe('medium');
    });
  });

  describe('rate limiting and deduplication', function () {
    it('period-deduplicates the same error across collection intervals', function () {
      // maxSameError = 1 so the second occurrence of the same error deduplicates.
      const dedupEmitter = new CaptureEmitter();
      const dedupCollector = new IncidentSnapshotCollector(
        600_000,
        5000,
        2500,
        'test-env',
        'test-svc',
        '0.0.1',
        1, // maxSameError
        dedupEmitter,
        null
      );
      const err = new Error('same');
      expect(dedupCollector.processPotentialIncident('/d', 'GET', 500, 10, err, makeRequestData())).not.toBeNull();
      // collect() clears the per-batch set so the next call reaches period dedup.
      dedupCollector.collect();
      expect(dedupCollector.processPotentialIncident('/d', 'GET', 500, 10, err, makeRequestData())).toBeNull();
      dedupCollector.stop();
    });

    it('rate-limits once maxPerPeriod distinct errors are exceeded', function () {
      const rlEmitter = new CaptureEmitter();
      const rlCollector = new IncidentSnapshotCollector(
        600_000,
        5000,
        2, // maxPerPeriod
        'test-env',
        'test-svc',
        '0.0.1',
        30,
        rlEmitter,
        null
      );
      expect(
        rlCollector.processPotentialIncident('/a', 'GET', 500, 10, new Error('a'), makeRequestData())
      ).not.toBeNull();
      expect(
        rlCollector.processPotentialIncident('/b', 'GET', 500, 10, new Error('b'), makeRequestData())
      ).not.toBeNull();
      // Third distinct error exceeds the rate limit.
      expect(rlCollector.processPotentialIncident('/c', 'GET', 500, 10, new Error('c'), makeRequestData())).toBeNull();
      rlCollector.stop();
    });

    it('a rate-limited request does NOT poison the dedup map for the same error', function () {
      // Regression: dedup state must only be recorded when a snapshot actually emits.
      // Previously the dedup map was mutated before the rate-limit check, so a
      // rate-limited error still consumed a dedup slot — and the next legitimate
      // occurrence of that same error was wrongly dropped as a duplicate.
      //
      // The rate-limit and dedup windows are both 60s, so the events are spaced in
      // time to open a window where the rate slot has freed but a (buggy) dedup
      // poison would still be alive: the filler's rate slot is taken at t=0 (expires
      // at t=60), the target is rate-limited at t=5 (a poison entry would live until
      // t=65), and the target is retried at t=62 — rate has room, and a poison entry
      // would still be present to wrongly drop it.
      const clock = sinon.useFakeTimers({ now: 1_000_000 });
      try {
        const rlEmitter = new CaptureEmitter();
        // maxPerPeriod=1 (rate window holds 1), maxSameError=1 (one same-error/period).
        const rlCollector = new IncidentSnapshotCollector(
          600_000,
          5000,
          1, // maxPerPeriod
          'test-env',
          'test-svc',
          '0.0.1',
          1, // maxSameError
          rlEmitter,
          null
        );

        // t=0: a different error fills the single rate-limit slot and emits.
        expect(
          rlCollector.processPotentialIncident('/other', 'GET', 500, 10, new Error('other'), makeRequestData())
        ).not.toBeNull();

        // t=5s: the target error arrives while the rate window is full → rate-limited
        // (returns null). This must NOT record a dedup occurrence for it.
        clock.tick(5_000);
        const target = new Error('target');
        expect(rlCollector.processPotentialIncident('/t', 'GET', 500, 10, target, makeRequestData())).toBeNull();

        // t=62s: the filler's rate slot (t=0) has expired so rate has room again, but
        // a buggy dedup poison from t=5 would still be alive (expires t=65). Clear the
        // per-batch set first (collect() runs each flush interval).
        clock.tick(57_000);
        rlCollector.collect();

        // The target error's FIRST real emission must succeed. Under the bug its dedup
        // slot was already consumed at t=5, so this was wrongly dropped as a duplicate.
        expect(rlCollector.processPotentialIncident('/t', 'GET', 500, 10, target, makeRequestData())).not.toBeNull();
        rlCollector.stop();
      } finally {
        clock.restore();
      }
    });

    it('rolls back the batch/dedup/rate-limit slots when collection throws', function () {
      // maxPerPeriod=1, maxSameError=1: a failed collection that leaves its slots claimed would
      // suppress every later occurrence of the same error for the window. Rollback must free them.
      const rbEmitter = new CaptureEmitter();
      const rbCollector = new IncidentSnapshotCollector(
        600_000,
        5000,
        1, // maxPerPeriod
        'test-env',
        'test-svc',
        '0.0.1',
        1, // maxSameError
        rbEmitter,
        null
      );
      // Force the FIRST collection to throw; subsequent calls collect normally.
      const collectStub = sinon
        .stub(rbCollector as unknown as { collectIncidentSnapshot: () => unknown }, 'collectIncidentSnapshot')
        .onFirstCall()
        .throws(new Error('collect boom'))
        .callThrough();
      try {
        const err = new Error('boom');
        // First occurrence passes all gates, claims slots, then collection throws → null, rollback.
        expect(rbCollector.processPotentialIncident('/x', 'GET', 500, 10, err, makeRequestData())).toBeNull();
        expect(rbEmitter.snapshots.length).toBe(0);
        // Second occurrence of the SAME error must still emit — the slots were freed. Under the bug
        // the batch/dedup/rate-limit slots stayed claimed and this was dropped.
        expect(rbCollector.processPotentialIncident('/x', 'GET', 500, 10, err, makeRequestData())).not.toBeNull();
        rbCollector.collect();
        expect(rbEmitter.snapshots.length).toBe(1);
      } finally {
        collectStub.restore();
        rbCollector.stop();
      }
    });

    it('a failed first collection does not strand the batch hash so Point #2 can still upgrade', function () {
      // With Point #2, a failed first collection that left errorHash in _currentBatchHashes with no
      // _pendingByHash entry would send a later sampled occurrence down the batch-dedup branch,
      // where the upgrade finds nothing pending and silently drops it. Rollback must clear the batch
      // hash so the later sampled occurrence is treated as fresh and emits its own correlated snapshot.
      const sampledTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const sampledSpanId = '00f067aa0ba902b7';
      const p2Emitter = new CaptureEmitter();
      const p2Collector = new IncidentSnapshotCollector(
        600_000,
        5000,
        30,
        'test-env',
        'test-svc',
        '0.0.1',
        30,
        p2Emitter,
        null
      );
      const collectStub = sinon
        .stub(p2Collector as unknown as { collectIncidentSnapshot: () => unknown }, 'collectIncidentSnapshot')
        .onFirstCall()
        .throws(new Error('collect boom'))
        .callThrough();
      try {
        const err = new Error('boom');
        // First (unsampled) occurrence: gates pass, slots claimed, collection throws → rolled back.
        expect(p2Collector.processPotentialIncident('/x', 'GET', 500, 10, err, makeRequestData())).toBeNull();
        // Later sampled occurrence of the same error: because the batch hash was rolled back, this is
        // a fresh snapshot (not a no-op upgrade of a non-existent pending), so it emits correlated.
        expect(
          p2Collector.processPotentialIncident(
            '/x',
            'GET',
            500,
            10,
            err,
            makeRequestData({ trace_id: sampledTraceId, span_id: sampledSpanId })
          )
        ).not.toBeNull();
        p2Collector.collect();
        expect(p2Emitter.snapshots.length).toBe(1);
        expect(p2Emitter.snapshots[0].telemetry_correlation.trace_id).toBe(sampledTraceId);
      } finally {
        collectStub.restore();
        p2Collector.stop();
      }
    });
  });

  describe('exception info from monitor investigation', function () {
    it('uses monitor-captured exception when no explicit Error passed', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();
      const inv = state.peekInvestigationData();
      inv!.callPath.push({ functionName: 'app.handler', callerFunctionName: null, durationNs: 1000 });
      inv!.exception = {
        name: 'TypeError',
        message: 'cannot read prop',
        traceback: 'TypeError: cannot read prop\n  at app.handler',
        functionName: 'app.handler',
      };
      // No explicit exception, but a 5xx status triggers the snapshot.
      collector.processPotentialIncident('/api/x', 'GET', 500, 10, null, makeRequestData());
      collector.collect();
      const info = emitter.snapshots[0].exception_info[0];
      expect(info.exception_type).toBe('TypeError');
      expect(info.exception_message).toBe('cannot read prop');
      expect(info.stack_trace).toContain('TypeError');
      expect(info.call_path.length).toBeGreaterThan(0);
    });

    it('synthesizes stack_trace when monitor exception has no traceback', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();
      const inv = state.peekInvestigationData();
      inv!.exception = {
        name: 'ValueError',
        message: 'bad value',
        traceback: '',
        functionName: 'app.handler',
      };
      collector.processPotentialIncident('/api/x', 'GET', 500, 10, null, makeRequestData());
      collector.collect();
      const info = emitter.snapshots[0].exception_info[0];
      expect(info.stack_trace).toBe('ValueError: bad value');
    });

    it('emits empty-field ExceptionInfo for latency incident with a call_path', function () {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();
      const inv = state.peekInvestigationData();
      inv!.callPath.push({ functionName: 'app.slow', callerFunctionName: null, durationNs: 9999 });
      // Latency trigger (no exception) but call path is present.
      collector.processPotentialIncident('/api/slow', 'GET', 200, 6000, null, makeRequestData());
      collector.collect();
      const info = emitter.snapshots[0].exception_info[0];
      expect(info.exception_type).toBe('');
      expect(info.exception_message).toBe('');
      expect(info.stack_trace).toBe('');
      expect(info.call_path[0].function_name).toBe('app.slow');
    });

    it('emits no ExceptionInfo for latency incident with no investigation data', function () {
      collector.processPotentialIncident('/api/slow', 'GET', 200, 6000, null, makeRequestData());
      collector.collect();
      expect(emitter.snapshots[0].exception_info).toEqual([]);
    });
  });

  describe('dedup keys on the recovered error identity (not route-only)', function () {
    // Regression: the span processor passes exception=null and defers exception detail to the
    // collector. The dedup hash must recover the error type+message from investigation data so two
    // DISTINCT errors on the same route do NOT collapse to one snapshot under maxSameError=1.
    function seedException(name: string, message: string): void {
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation(true);
      const inv = state.peekInvestigationData();
      inv!.exception = { name, message, traceback: `${name}: ${message}`, functionName: 'app.handler' };
    }

    it('two distinct error TYPES on the same route both emit (maxSameError=1)', function () {
      const c = new IncidentSnapshotCollector(600_000, 5000, 100, 'env', 'svc', '0.0.1', 1, emitter, null);
      try {
        seedException('TypeError', 'x');
        expect(c.processPotentialIncident('/orders', 'POST', 500, 10, null, makeRequestData())).not.toBeNull();
        c.collect(); // clears the per-batch set so the next call reaches period dedup
        seedException('RangeError', 'y');
        expect(c.processPotentialIncident('/orders', 'POST', 500, 10, null, makeRequestData())).not.toBeNull();
        c.collect();
        expect(emitter.snapshots.length).toBe(2);
      } finally {
        c.stop();
      }
    });

    it('two distinct error MESSAGES of the same type on one route both emit (maxSameError=1)', function () {
      const c = new IncidentSnapshotCollector(600_000, 5000, 100, 'env', 'svc', '0.0.1', 1, emitter, null);
      try {
        seedException('DbError', 'timeout on shard A');
        expect(c.processPotentialIncident('/orders', 'POST', 500, 10, null, makeRequestData())).not.toBeNull();
        c.collect();
        seedException('DbError', 'timeout on shard B');
        expect(c.processPotentialIncident('/orders', 'POST', 500, 10, null, makeRequestData())).not.toBeNull();
        c.collect();
        expect(emitter.snapshots.length).toBe(2);
      } finally {
        c.stop();
      }
    });

    it('the SAME error (type+message) on one route deduplicates (maxSameError=1)', function () {
      const c = new IncidentSnapshotCollector(600_000, 5000, 100, 'env', 'svc', '0.0.1', 1, emitter, null);
      try {
        seedException('DbError', 'timeout');
        expect(c.processPotentialIncident('/orders', 'POST', 500, 10, null, makeRequestData())).not.toBeNull();
        c.collect();
        seedException('DbError', 'timeout');
        // Same recovered identity → same hash → period-deduplicated.
        expect(c.processPotentialIncident('/orders', 'POST', 500, 10, null, makeRequestData())).toBeNull();
        c.collect();
        expect(emitter.snapshots.length).toBe(1);
      } finally {
        c.stop();
      }
    });

    it('a latency incident (no exception) still keys route-only', function () {
      const c = new IncidentSnapshotCollector(600_000, 5000, 100, 'env', 'svc', '0.0.1', 1, emitter, null);
      try {
        // No investigation exception; two slow 2xx on the same route dedup together (route-only).
        expect(c.processPotentialIncident('/slow', 'GET', 200, 6000, null, makeRequestData())).not.toBeNull();
        c.collect();
        expect(c.processPotentialIncident('/slow', 'GET', 200, 6000, null, makeRequestData())).toBeNull();
        c.collect();
        expect(emitter.snapshots.length).toBe(1);
      } finally {
        c.stop();
      }
    });
  });

  describe('rate-limited request does not poison dedup (pure-check/commit)', function () {
    it('a rate-limited error does not consume a dedup slot for the same error', function () {
      // maxPerMinute=1, maxSameError=1. Two DISTINCT errors: the first emits (consuming the single
      // rate slot); the second is rate-limited. That rate-limited attempt must NOT record a dedup
      // occurrence — otherwise a later retry of it (after the rate window frees) would be dropped as
      // a duplicate even though it never produced a snapshot.
      const c = new IncidentSnapshotCollector(600_000, 5000, 1, 'env', 'svc', '0.0.1', 1, emitter, null);
      try {
        const errA = new Error('A');
        const errB = new Error('B');
        expect(c.processPotentialIncident('/x', 'GET', 500, 10, errA, makeRequestData())).not.toBeNull();
        // Second distinct error: gates would pass dedup but the rate window (1) is full → rejected.
        expect(c.processPotentialIncident('/x', 'GET', 500, 10, errB, makeRequestData())).toBeNull();
        // errB left NO dedup timestamp and NO batch entry behind. Free the rate window and retry it
        // in a fresh cycle: it must now emit (it was never actually recorded).
        (c as unknown as { _snapshotTimestamps: number[] })._snapshotTimestamps = [];
        c.collect();
        expect(c.processPotentialIncident('/x', 'GET', 500, 10, errB, makeRequestData())).not.toBeNull();
      } finally {
        c.stop();
      }
    });
  });

  describe('endpoint exemplar tracks a Point #2 upgrade', function () {
    const sampledTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const sampledSpanId = '00f067aa0ba902b7';

    it('re-syncs the returned exemplar (snapshot_id + timestamp) to the upgraded snapshot', function () {
      // Advance the clock between the two occurrences so the upgraded snapshot gets a DIFFERENT
      // timestamp than the first. This is what makes the in-place exemplar.timestamp sync observable:
      // if the mutation were dropped, the exemplar would keep the first occurrence's timestamp while
      // the emitted snapshot carries the later one.
      const clock = sinon.useFakeTimers({ now: 1_000_000 });
      try {
        const err = new Error('boom');
        // First (unsampled) occurrence. This is the exemplar the endpoint collector records.
        const exemplar = collector.processPotentialIncident('/api/x', 'POST', 500, 50, err, makeRequestData());
        expect(exemplar).not.toBeNull();
        const firstTimestamp = exemplar!.timestamp;
        // Advance 5s, then a SAMPLED occurrence of the same error upgrades the pending snapshot
        // wholesale. The already-returned exemplar object (held by reference by the endpoint
        // collector) must track the swap.
        clock.tick(5_000);
        collector.processPotentialIncident(
          '/api/x',
          'POST',
          500,
          50,
          err,
          makeRequestData({ trace_id: sampledTraceId, span_id: sampledSpanId })
        );
        collector.collect();
        expect(emitter.snapshots.length).toBe(1);
        // The emitter serializes snapshot_id/trigger_type/timestamp for the exemplar (severity is NOT
        // on the wire), so those must stay coherent with the emitted (upgraded) snapshot.
        expect(exemplar!.snapshot_id).toBe(emitter.snapshots[0].snapshot_id);
        expect(exemplar!.trigger_type).toBe(emitter.snapshots[0].trigger_type);
        // The exemplar timestamp moved to the upgraded snapshot's (later) timestamp, not the first.
        expect(emitter.snapshots[0].timestamp).toBeGreaterThan(firstTimestamp);
        expect(exemplar!.timestamp).toBe(emitter.snapshots[0].timestamp);
        // The upgraded snapshot now carries the sampled trace correlation.
        expect(emitter.snapshots[0].telemetry_correlation.trace_id).toBe(sampledTraceId);
      } finally {
        clock.restore();
      }
    });

    it('preserves the first occurrence affected_endpoint when a different-method occurrence upgrades', function () {
      // The dedup hash keys on route (not method), so GET /api/x and POST /api/x with the same error
      // share a hash. The exemplar is filed under the FIRST occurrence's operation, so the swapped
      // snapshot must keep the first occurrence's affected_endpoint, not adopt the upgrader's method.
      const err = new Error('boom');
      const exemplar = collector.processPotentialIncident('/api/x', 'GET', 500, 50, err, makeRequestData());
      expect(exemplar).not.toBeNull();
      // Sampled POST occurrence of the same error upgrades the pending (unsampled) GET snapshot.
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        err,
        makeRequestData({ trace_id: sampledTraceId, span_id: sampledSpanId })
      );
      collector.collect();
      expect(emitter.snapshots.length).toBe(1);
      // affected_endpoint stays 'GET /api/x' (the exemplar's filed operation), NOT 'POST /api/x'.
      expect(emitter.snapshots[0].affected_endpoint).toBe('GET /api/x');
      expect(emitter.snapshots[0].snapshot_id).toBe(exemplar!.snapshot_id);
    });
  });

  describe('buildCallPath function registry enrichment', function () {
    afterEach(function () {
      clearFunctionRegistry();
    });

    it('annotates is_async and function_at_line from the function registry', function () {
      // Register a composite function name with async + line metadata.
      const composite = calculateFunctionName('handler', '/app/routes.js', 42, true);
      const state = ServiceEventsMonitorState.getInstance();
      state.beginInvestigation();
      state.recordCallPathEntry(composite, null, 1000);
      collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
      collector.collect();
      const cp = emitter.snapshots[0].exception_info[0].call_path[0];
      expect(cp.is_async).toBe(true);
      expect(cp.function_at_line).toBe(42);
    });
  });

  describe('trace correlation is sampling-gated (fix #1)', function () {
    const validTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const validSpanId = '00f067aa0ba902b7';

    it('uses the span processor supplied (SAMPLED-gated) trace_id and span_id verbatim', function () {
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        new Error('boom'),
        makeRequestData({ trace_id: validTraceId, span_id: validSpanId })
      );
      collector.collect();
      const corr = emitter.snapshots[0].telemetry_correlation;
      expect(corr.trace_id).toBe(validTraceId);
      expect(corr.span_id).toBe(validSpanId);
    });

    it('leaves trace_id and span_id undefined for an unsampled request (no supplied ids)', function () {
      // The span processor sets trace_id/span_id only when the trace was sampled (fix #1). An
      // unsampled request supplies neither, so the snapshot is complete but uncorrelated.
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        new Error('boom'),
        makeRequestData() // no trace_id/span_id
      );
      collector.collect();
      const corr = emitter.snapshots[0].telemetry_correlation;
      expect(corr.trace_id).toBeUndefined();
      expect(corr.span_id).toBeUndefined();
    });

    it('never re-derives correlation from inbound trace headers (headers are ignored)', function () {
      // Even with a well-formed W3C traceparent present, an unsampled request (no supplied
      // trace_id) must emit no trace link — the collector never consults headers or the active
      // span, so the header cannot resurrect a link fix #1 gated out.
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        new Error('boom'),
        makeRequestData({ headers: { traceparent: `00-${validTraceId}-${validSpanId}-01` } })
      );
      collector.collect();
      const corr = emitter.snapshots[0].telemetry_correlation;
      expect(corr.trace_id).toBeUndefined();
      expect(corr.span_id).toBeUndefined();
    });

    it('correlation_ids is always an empty object', function () {
      collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
      collector.collect();
      expect(emitter.snapshots[0].telemetry_correlation.correlation_ids).toEqual({});
    });
  });

  describe('in-batch sampled-preference upgrade (Point #2)', function () {
    const sampledTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const sampledSpanId = '00f067aa0ba902b7';

    it('a later sampled occurrence upgrades an earlier unsampled pending snapshot', function () {
      const err = new Error('boom');
      // First occurrence is unsampled → snapshot pends with no trace link.
      const first = collector.processPotentialIncident('/api/x', 'POST', 500, 50, err, makeRequestData());
      expect(first).not.toBeNull();
      // Second occurrence (same error hash) is sampled → batch-deduped, but upgrades the pending one.
      const second = collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        err,
        makeRequestData({ trace_id: sampledTraceId, span_id: sampledSpanId })
      );
      expect(second).toBeNull(); // batch-deduplicated
      collector.collect();
      // Exactly one snapshot emits, and it carries the sampled occurrence's trace link.
      expect(emitter.snapshots.length).toBe(1);
      const corr = emitter.snapshots[0].telemetry_correlation;
      expect(corr.trace_id).toBe(sampledTraceId);
      expect(corr.span_id).toBe(sampledSpanId);
      // Identity is preserved so the already-emitted endpoint exemplar pointer stays valid.
      expect(emitter.snapshots[0].snapshot_id).toBe(first!.snapshot_id);
    });

    it('the upgraded snapshot body stays coherent with the trace it links to', function () {
      // The swap is whole-snapshot, not correlation-only: the emitted body must be the SAMPLED
      // occurrence's, so its duration matches the trace it now points at.
      const err = new Error('boom');
      collector.processPotentialIncident('/api/x', 'POST', 500, 50, err, makeRequestData());
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        999, // distinct duration for the sampled occurrence
        err,
        makeRequestData({ trace_id: sampledTraceId, span_id: sampledSpanId })
      );
      collector.collect();
      expect(emitter.snapshots.length).toBe(1);
      expect(emitter.snapshots[0].duration_ms).toBe(999);
      expect(emitter.snapshots[0].telemetry_correlation.trace_id).toBe(sampledTraceId);
    });

    it('does not upgrade when the pending snapshot is already sampled (first sampled wins)', function () {
      const err = new Error('boom');
      const otherTraceId = 'ffffffffffffffffffffffffffffffff';
      // First occurrence is already sampled.
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        err,
        makeRequestData({ trace_id: sampledTraceId, span_id: sampledSpanId })
      );
      // Second sampled occurrence must NOT overwrite it.
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        err,
        makeRequestData({ trace_id: otherTraceId, span_id: '1111111111111111' })
      );
      collector.collect();
      expect(emitter.snapshots.length).toBe(1);
      expect(emitter.snapshots[0].telemetry_correlation.trace_id).toBe(sampledTraceId);
    });

    it('an unsampled later occurrence never downgrades or replaces the pending snapshot', function () {
      const err = new Error('boom');
      // First occurrence sampled.
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        err,
        makeRequestData({ trace_id: sampledTraceId, span_id: sampledSpanId })
      );
      // Second occurrence unsampled → no trace_id, so it cannot upgrade; leave the sampled one.
      collector.processPotentialIncident('/api/x', 'POST', 500, 50, err, makeRequestData());
      collector.collect();
      expect(emitter.snapshots.length).toBe(1);
      expect(emitter.snapshots[0].telemetry_correlation.trace_id).toBe(sampledTraceId);
    });

    it('the per-hash upgrade index does not survive a collect() cycle', function () {
      const err = new Error('boom');
      // Cycle 1: unsampled snapshot pends and flushes.
      collector.processPotentialIncident('/api/x', 'POST', 500, 50, err, makeRequestData());
      collector.collect();
      expect(emitter.snapshots.length).toBe(1);
      expect(emitter.snapshots[0].telemetry_correlation.trace_id).toBeUndefined();
      // Cycle 2: a sampled occurrence of the same error is a fresh snapshot (not an upgrade of the
      // already-flushed one), so it emits with its own trace link.
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        err,
        makeRequestData({ trace_id: sampledTraceId, span_id: sampledSpanId })
      );
      collector.collect();
      expect(emitter.snapshots.length).toBe(2);
      expect(emitter.snapshots[1].telemetry_correlation.trace_id).toBe(sampledTraceId);
    });
  });
});

describe('IncidentSnapshotCollector per-endpoint latency thresholds', function () {
  let emitter: CaptureEmitter;

  beforeEach(function () {
    resetMonitorState();
    emitter = new CaptureEmitter();
  });

  afterEach(function () {
    resetMonitorState();
  });

  // Global default threshold is 5000ms. Per-endpoint patterns override it.
  function makeCollector(patterns: Array<[string, number]>): IncidentSnapshotCollector {
    return new IncidentSnapshotCollector(
      600_000,
      5000, // global durationThresholdMs
      2500,
      'test-env',
      'test-svc',
      '0.0.1',
      30,
      emitter,
      null,
      patterns
    );
  }

  it('uses an exact per-endpoint threshold below the global default', function () {
    // POST /api/checkout has a 200ms threshold; a 300ms request must trigger
    // even though it is well under the 5000ms global default.
    const collector = makeCollector([['POST /api/checkout', 200]]);
    const exemplar = collector.processPotentialIncident(
      '/api/checkout',
      'POST',
      200,
      300, // ms — over the 200ms per-endpoint threshold, under the 5000ms global
      null,
      makeRequestData()
    );
    expect(exemplar).not.toBeNull();
    expect(exemplar!.trigger_type).toBe('latency');
  });

  it('matches glob patterns (first match wins)', function () {
    const collector = makeCollector([
      ['GET /api/health', 50],
      ['GET /api/*', 1000],
    ]);
    // /api/health → 50ms threshold; a 100ms request triggers.
    expect(collector.processPotentialIncident('/api/health', 'GET', 200, 100, null, makeRequestData())).not.toBeNull();
    // /api/reports → matches the GET /api/* glob (1000ms); a 100ms request does NOT trigger.
    expect(collector.processPotentialIncident('/api/reports', 'GET', 200, 100, null, makeRequestData())).toBeNull();
  });

  it('falls back to the global default when no pattern matches', function () {
    const collector = makeCollector([['POST /api/checkout', 200]]);
    // GET /other has no matching pattern → global 5000ms; a 300ms request does not trigger.
    expect(collector.processPotentialIncident('/other', 'GET', 200, 300, null, makeRequestData())).toBeNull();
    // …but a 6000ms request does (exceeds the 5000ms global default).
    expect(collector.processPotentialIncident('/other', 'GET', 200, 6000, null, makeRequestData())).not.toBeNull();
  });

  it('with no patterns configured, behaves exactly like the global default', function () {
    const collector = makeCollector([]);
    expect(collector.processPotentialIncident('/api/x', 'GET', 200, 300, null, makeRequestData())).toBeNull();
    expect(collector.processPotentialIncident('/api/x', 'GET', 200, 6000, null, makeRequestData())).not.toBeNull();
  });

  // resolveLatencyThresholdMs is public so the framework instrumentation gates can
  // resolve the SAME per-endpoint threshold the collector uses. Previously the gates
  // hard-coded the global default, so any sub-global per-endpoint threshold was dead
  // (a slow request over its endpoint limit but under the global never reached the
  // collector). These assert the resolver the gates now call.
  it('resolveLatencyThresholdMs returns the per-endpoint threshold for the gate', function () {
    const collector = makeCollector([
      ['POST /api/checkout', 200],
      ['GET /api/*', 1000],
    ]);
    expect(collector.resolveLatencyThresholdMs('POST', '/api/checkout')).toBe(200);
    expect(collector.resolveLatencyThresholdMs('post', '/api/checkout')).toBe(200); // method case-insensitive
    expect(collector.resolveLatencyThresholdMs('GET', '/api/reports')).toBe(1000); // glob
    expect(collector.resolveLatencyThresholdMs('GET', '/other')).toBe(5000); // global default fallback
  });
});
