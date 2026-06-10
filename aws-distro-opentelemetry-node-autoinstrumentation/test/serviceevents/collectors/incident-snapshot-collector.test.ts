// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import { trace } from '@opentelemetry/api';
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
  return {
    headers: { 'content-type': 'application/json' },
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
        expect(
          rlCollector.processPotentialIncident('/t', 'GET', 500, 10, target, makeRequestData())
        ).not.toBeNull();
        rlCollector.stop();
      } finally {
        clock.restore();
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

  describe('custom context and correlation extraction', function () {
    // The full suite registers a global tracer provider, so trace.getActiveSpan()
    // may return a live span and short-circuit the header-fallback paths under
    // test. Stub it to undefined so the header-extraction branches are exercised
    // deterministically regardless of test ordering.
    beforeEach(function () {
      sinon.stub(trace, 'getActiveSpan').returns(undefined);
    });

    afterEach(function () {
      sinon.restore();
    });

    it('extracts trace_id and span_id from traceparent header', function () {
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        new Error('boom'),
        makeRequestData({
          headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
        })
      );
      collector.collect();
      const corr = emitter.snapshots[0].telemetry_correlation;
      expect(corr.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(corr.span_id).toBe('b7ad6b7169203331');
    });

    it('ignores a malformed X-Ray Root id and falls through', function () {
      // `Root=1-abc` is not a valid X-Ray trace id (8-hex-4-byte epoch + 24-hex
      // unique segment), so it must NOT be returned raw. With no other usable
      // header and no active span, trace_id is left undefined.
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        new Error('boom'),
        makeRequestData({ headers: { 'x-amzn-trace-id': 'Root=1-abc' } })
      );
      collector.collect();
      expect(emitter.snapshots[0].telemetry_correlation.trace_id).toBeUndefined();
    });

    it('falls back to x-datadog-trace-id header for trace_id', function () {
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        new Error('boom'),
        makeRequestData({ headers: { 'x-datadog-trace-id': '1234567890' } })
      );
      collector.collect();
      expect(emitter.snapshots[0].telemetry_correlation.trace_id).toBe('1234567890');
    });

    it('leaves trace_id and span_id undefined when no headers or span present', function () {
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        new Error('boom'),
        makeRequestData({ headers: {} })
      );
      collector.collect();
      const corr = emitter.snapshots[0].telemetry_correlation;
      expect(corr.trace_id).toBeUndefined();
      expect(corr.span_id).toBeUndefined();
    });

    it('does not set span_id when traceparent has fewer than 3 parts', function () {
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        new Error('boom'),
        makeRequestData({ headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c' } })
      );
      collector.collect();
      const corr = emitter.snapshots[0].telemetry_correlation;
      expect(corr.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(corr.span_id).toBeUndefined();
    });

    it('correlation_ids is always an empty object', function () {
      collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
      collector.collect();
      expect(emitter.snapshots[0].telemetry_correlation.correlation_ids).toEqual({});
    });
  });

  describe('trace/span extraction from the active OTel span', function () {
    const validTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const validSpanId = '00f067aa0ba902b7';

    afterEach(function () {
      sinon.restore();
    });

    it('prefers the active span trace_id and span_id over headers', function () {
      sinon.stub(trace, 'getActiveSpan').returns({
        spanContext: () => ({ traceId: validTraceId, spanId: validSpanId, traceFlags: 1 }),
      } as never);
      collector.processPotentialIncident(
        '/api/x',
        'POST',
        500,
        50,
        new Error('boom'),
        // Headers also present, but the active span wins.
        makeRequestData({ headers: { traceparent: '00-ffffffffffffffffffffffffffffffff-aaaaaaaaaaaaaaaa-01' } })
      );
      collector.collect();
      const corr = emitter.snapshots[0].telemetry_correlation;
      expect(corr.trace_id).toBe(validTraceId);
      expect(corr.span_id).toBe(validSpanId);
    });

    it('ignores all-zero span context and falls back to headers', function () {
      sinon.stub(trace, 'getActiveSpan').returns({
        spanContext: () => ({
          traceId: '00000000000000000000000000000000',
          spanId: '0000000000000000',
          traceFlags: 0,
        }),
      } as never);
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
      expect(corr.trace_id).toBe(validTraceId);
      expect(corr.span_id).toBe(validSpanId);
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
