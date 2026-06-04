// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  IncidentSnapshotCollector,
  RequestData,
} from '../../../src/serviceevents/collectors/incident-snapshot-collector';
import { ServiceEventsMonitorState, resetMonitorState } from '../../../src/serviceevents/serviceevents-monitor';
import { ServiceEventsOtlpEmitter } from '../../../src/serviceevents/exporter/otlp-emitter';
import { IncidentSnapshot } from '../../../src/serviceevents/models/incident-telemetry';

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
    args: {},
    viewArgs: {},
    cachedBody: null,
    ...overrides,
  };
}

describe('IncidentSnapshotCollector (OTLP)', function () {
  let collector: IncidentSnapshotCollector;
  let emitter: CaptureEmitter;

  beforeEach(function () {
    resetMonitorState();
    emitter = new CaptureEmitter();
    collector = new IncidentSnapshotCollector(
      600_000,
      5000,
      2500,
      'test-env',
      'test-svc',
      '0.0.1',
      true,
      30,
      emitter,
      null
    );
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

  it('captures request payload fields when capture flag ON', function () {
    collector.processPotentialIncident(
      '/api/x',
      'POST',
      500,
      50,
      new Error('boom'),
      makeRequestData({
        cachedBody: { hello: 'world' },
        args: { q: 'v' },
        viewArgs: { id: '1' },
        headers: { 'content-type': 'application/json' },
      })
    );
    collector.collect();
    const snap = emitter.snapshots[0];
    expect(snap.request_context.request_body).toEqual({ hello: 'world' });
    expect(snap.request_context.query_params).toEqual({ q: 'v' });
    expect(snap.request_context.path_params).toEqual({ id: '1' });
    expect(snap.request_context.request_headers).toEqual({ 'content-type': 'application/json' });
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

  it('omits request payload fields when capture flag OFF', function () {
    resetMonitorState();
    const gatedEmitter = new CaptureEmitter();
    const gatedCollector = new IncidentSnapshotCollector(
      600_000,
      5000,
      2500,
      'test-env',
      'test-svc',
      '0.0.1',
      false, // captureRequestBody = OFF
      30,
      gatedEmitter,
      null
    );
    gatedCollector.processPotentialIncident(
      '/api/x',
      'POST',
      500,
      50,
      new Error('boom'),
      makeRequestData({ cachedBody: { secret: 's' }, args: { q: 'v' } })
    );
    gatedCollector.collect();
    gatedCollector.stop();
    const snap = gatedEmitter.snapshots[0];
    expect(snap.request_context.request_body).toBeUndefined();
    expect(snap.request_context.query_params).toBeUndefined();
    expect(snap.request_context.path_params).toBeUndefined();
    expect(snap.request_context.request_headers).toBeUndefined();
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

  describe('profiler_call_path removed (spec §5)', function () {
    // The field was removed from spec §5; profiler stack correlation is now
    // backend-side via traceId/spanId joined to AggregateProfile.link_table.
    // These tests guard against regression: the snapshot must NEVER carry it.

    it('IncidentSnapshot has no profiler_call_path field', function () {
      collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
      collector.collect();
      const snap = emitter.snapshots[0];
      expect(snap).toBeDefined();
      expect((snap as unknown as Record<string, unknown>).profiler_call_path).toBeUndefined();
      expect((snap as unknown as Record<string, unknown>).profiler_stacks).toBeUndefined();
    });

    it('serialized snapshot dict has no profiler_call_path', function () {
      collector.processPotentialIncident('/api/x', 'POST', 500, 50, new Error('boom'), makeRequestData());
      collector.collect();
      const dict = emitter.snapshots[0].toDict();
      expect(dict.profiler_call_path).toBeUndefined();
      expect(dict.profiler_stacks).toBeUndefined();
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
      true,
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
});
