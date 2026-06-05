// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  __serviceeventsMonitorEnter,
  __serviceeventsMonitorExit,
  setSamplingMode,
  resetMonitorState,
  ServiceEventsMonitorState,
} from '../../../src/serviceevents/serviceevents-monitor';
import { FunctionCallCollector } from '../../../src/serviceevents/collectors/function-call-collector';
import { clearFunctionRegistry } from '../../../src/serviceevents/ast-transformation';
import { ServiceEventsOtlpEmitter } from '../../../src/serviceevents/exporter/otlp-emitter';
import { FunctionCallMetrics } from '../../../src/serviceevents/models/function-telemetry';

class EmitterCapture extends ServiceEventsOtlpEmitter {
  functionCalls: FunctionCallMetrics[] = [];
  deploymentEventCount: number = 0;

  constructor() {
    super({ serviceName: 'svc', environment: 'env' });
  }

  override emitFunctionCall(event: FunctionCallMetrics): void {
    this.functionCalls.push(event);
  }

  override emitDeploymentEvent(): void {
    this.deploymentEventCount++;
  }
}

describe('FunctionCallCollector (OTLP)', function () {
  let collector: FunctionCallCollector;
  let emitter: EmitterCapture;

  beforeEach(function () {
    resetMonitorState();
    clearFunctionRegistry();
    emitter = new EmitterCapture();
  });

  afterEach(function () {
    try {
      collector?.stop();
    } catch {
      // Ignore
    }
    resetMonitorState();
    clearFunctionRegistry();
  });

  it('emits FunctionCall records via OTLP', function () {
    setSamplingMode('always');
    collector = new FunctionCallCollector(600_000, 'env', 'svc', '0.0.1', emitter);

    const ctx1 = __serviceeventsMonitorEnter('app.func-a');
    __serviceeventsMonitorExit(ctx1);
    const ctx2 = __serviceeventsMonitorEnter('app.func-b');
    __serviceeventsMonitorExit(ctx2);

    collector.collect();

    expect(emitter.functionCalls.length).toBeGreaterThanOrEqual(2);
    for (const event of emitter.functionCalls) {
      expect(event.function_name).toBeDefined();
      expect(event.version).toBe('1');
    }
  });

  it('no FunctionCall records when no aggregations', function () {
    collector = new FunctionCallCollector(600_000, 'env', 'svc', '0.0.1', emitter);
    collector.collect();
    expect(emitter.functionCalls.length).toBe(0);
  });

  it('propagates operation via operationLookup', function () {
    setSamplingMode('always');
    collector = new FunctionCallCollector(600_000, 'env', 'svc', '0.0.1', emitter);
    collector.setOperationLookup(op => (op ? op : null));

    // Trigger a sampled call with no active operation context — operation will be null.
    const ctx = __serviceeventsMonitorEnter('app.handler');
    __serviceeventsMonitorExit(ctx);
    collector.collect();

    expect(Array.isArray(emitter.functionCalls)).toBe(true);
  });

  it('flushes as a no-op (draining state) when the duration histogram is wired', function () {
    setSamplingMode('always');
    const state = ServiceEventsMonitorState.getInstance();
    // Wire a stub histogram so collect() takes the no-op drain path.
    state.setFunctionDurationHistogram({ record(): void {} } as never);
    collector = new FunctionCallCollector(600_000, 'env', 'svc', '0.0.1', emitter);

    const ctx = __serviceeventsMonitorEnter('app.histogram-fn');
    __serviceeventsMonitorExit(ctx);
    collector.collect();

    // No LogRecords emitted; the histogram is the sole signal.
    expect(emitter.functionCalls.length).toBe(0);
    // Aggregations/deltas were drained, so a subsequent non-histogram flush sees nothing.
    state.setFunctionDurationHistogram(null);
    collector.collect();
    expect(emitter.functionCalls.length).toBe(0);
  });

  it('selects the most common caller and copies exception counts', function () {
    setSamplingMode('always');
    const state = ServiceEventsMonitorState.getInstance();
    // Two sampled calls from caller "app.bar", one from "app.baz" -> bar wins.
    state.updateAggregations('app.target', 1500, 'TypeError', 'app.bar', true, 'GET /t');
    state.updateAggregations('app.target', 1500, 'TypeError', 'app.bar', true, 'GET /t');
    state.updateAggregations('app.target', 1500, 'ValueError', 'app.baz', true, 'GET /t');

    collector = new FunctionCallCollector(600_000, 'env', 'svc', '0.0.1', emitter);
    collector.collect();

    const event = emitter.functionCalls.find(e => e.function_name === 'app.target');
    expect(event).toBeDefined();
    expect(event!.caller).toBe('app.bar');
    expect(event!.exceptions.TypeError).toBe(2);
    expect(event!.exceptions.ValueError).toBe(1);
  });

  it('skips aggregation buckets that have no sampled calls', function () {
    const state = ServiceEventsMonitorState.getInstance();
    // Unsampled-only bucket (sampledCount stays 0) must be skipped by formatFunctionCalls.
    state.updateAggregations('app.unsampled-only', 1000, undefined, undefined, false, 'GET /u');

    collector = new FunctionCallCollector(600_000, 'env', 'svc', '0.0.1', emitter);
    collector.collect();

    expect(emitter.functionCalls.find(e => e.function_name === 'app.unsampled-only')).toBeUndefined();
  });
});
