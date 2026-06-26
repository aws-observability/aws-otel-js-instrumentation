// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { trace } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import expect from 'expect';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
  registerSpanProcessorOnActiveProvider,
  ServiceEventsInstrumentation,
} from '../../../src/serviceevents/serviceevents-instrumentation';
import { createServiceEventsConfigFromEnv } from '../../../src/serviceevents/config';

function fakeProcessor(): SpanProcessor {
  return {
    onStart: () => {},
    onEnd: () => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
}

describe('registerSpanProcessorOnActiveProvider', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('uses a public addSpanProcessor when the delegate exposes one', function () {
    const added: SpanProcessor[] = [];
    const delegate = { addSpanProcessor: (p: SpanProcessor) => added.push(p) };
    sinon.stub(trace, 'getTracerProvider').returns({ getDelegate: () => delegate } as any);

    const proc = fakeProcessor();
    expect(registerSpanProcessorOnActiveProvider(proc)).toBe(true);
    expect(added).toEqual([proc]);
  });

  it('splices into the live MultiSpanProcessor array on SDK 2.x (no addSpanProcessor)', function () {
    const spanProcessors: SpanProcessor[] = [];
    const delegate = { _activeSpanProcessor: { _spanProcessors: spanProcessors } };
    sinon.stub(trace, 'getTracerProvider').returns({ getDelegate: () => delegate } as any);

    const proc = fakeProcessor();
    expect(registerSpanProcessorOnActiveProvider(proc)).toBe(true);
    expect(spanProcessors).toEqual([proc]);
  });

  it('works when the provider is not a proxy (no getDelegate)', function () {
    const spanProcessors: SpanProcessor[] = [];
    const provider = { _activeSpanProcessor: { _spanProcessors: spanProcessors } };
    sinon.stub(trace, 'getTracerProvider').returns(provider as any);

    expect(registerSpanProcessorOnActiveProvider(fakeProcessor())).toBe(true);
    expect(spanProcessors.length).toBe(1);
  });

  it('returns false when neither strategy is reachable', function () {
    sinon.stub(trace, 'getTracerProvider').returns({ getDelegate: () => ({}) } as any);
    expect(registerSpanProcessorOnActiveProvider(fakeProcessor())).toBe(false);
  });

  it('returns false (never throws) when the provider lookup throws', function () {
    sinon.stub(trace, 'getTracerProvider').throws(new Error('boom'));
    expect(registerSpanProcessorOnActiveProvider(fakeProcessor())).toBe(false);
  });
});

describe('ServiceEventsInstrumentation endpoint span processor wiring', function () {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(function () {
    savedEnv = {
      enabled: process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED,
      outFile: process.env.OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE,
    };
    process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = 'true';
    // File-export mode so the emitter never touches the network.
    process.env.OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE = path.join(os.tmpdir(), `se-wiring-test-${process.pid}.ndjson`);
  });

  afterEach(async function () {
    sinon.restore();
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore('OTEL_AWS_SERVICE_EVENTS_ENABLED', savedEnv.enabled);
    restore('OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE', savedEnv.outFile);
  });

  it('registers the endpoint span processor on the active provider', async function () {
    // A registrable stub provider so the splice strategy succeeds.
    const spanProcessors: SpanProcessor[] = [];
    sinon
      .stub(trace, 'getTracerProvider')
      .returns({ getDelegate: () => ({ _activeSpanProcessor: { _spanProcessors: spanProcessors } }) } as any);

    const config = createServiceEventsConfigFromEnv();
    const instr = new ServiceEventsInstrumentation(config);
    instr.initialize();

    // The endpoint span processor — the sole endpoint-measurement path — was registered.
    expect(spanProcessors.length).toBe(1);

    await instr.shutdown();
  });

  it('initializes without throwing when the processor cannot be registered', async function () {
    // A provider neither strategy can register on (no addSpanProcessor, no _activeSpanProcessor) →
    // registerSpanProcessorOnActiveProvider returns false. Init logs a warning and emits no endpoint
    // signals (there is no longer a legacy hook fallback), but must not throw.
    sinon.stub(trace, 'getTracerProvider').returns({ getDelegate: () => ({}) } as any);

    const config = createServiceEventsConfigFromEnv();
    const instr = new ServiceEventsInstrumentation(config);
    instr.initialize();

    expect(instr.isInitialized()).toBe(true);

    await instr.shutdown();
  });
});
