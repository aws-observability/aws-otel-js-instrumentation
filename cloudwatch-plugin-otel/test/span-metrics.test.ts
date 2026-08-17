// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { AlwaysOnSampler, BatchSpanProcessor, InMemorySpanExporter, Sampler } from '@opentelemetry/sdk-trace-base';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { bind, withSpanMetrics } from '../src/span-metrics';
import { AlwaysRecordSampler } from '../src/always-record-sampler';
import { SpanMetricsProcessor } from '../src/span-metrics-processor';
import * as holder from '../src/internal/open-telemetry-holder';

describe('bind (holder)', () => {
  beforeEach(() => holder.resetForTest());

  it('binds a MeterProvider that the processor can read', () => {
    const mp = new MeterProvider();
    bind(mp);
    assert.strictEqual(holder.get(), mp);
  });

  it('is first-wins: a later different provider is ignored', () => {
    const first = new MeterProvider();
    const second = new MeterProvider();
    bind(first);
    bind(second);
    assert.strictEqual(holder.get(), first);
  });

  it('is idempotent for the same provider', () => {
    const mp = new MeterProvider();
    bind(mp);
    bind(mp);
    assert.strictEqual(holder.get(), mp);
  });
});

describe('withSpanMetrics', () => {
  it('wraps a configured sampler and appends the processor', () => {
    const config = { sampler: new AlwaysOnSampler() as Sampler, spanProcessors: [] as any[] };
    const out = withSpanMetrics(config);
    assert.ok(out.sampler instanceof AlwaysRecordSampler);
    assert.strictEqual(out.spanProcessors!.length, 1);
    assert.ok(out.spanProcessors![0] instanceof SpanMetricsProcessor);
  });

  it('preserves existing span processors and appends ours last', () => {
    const existing = { onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: async () => {} };
    const out = withSpanMetrics({ spanProcessors: [existing] as any[] });
    assert.strictEqual(out.spanProcessors!.length, 2);
    assert.strictEqual(out.spanProcessors![0], existing);
    assert.ok(out.spanProcessors![1] instanceof SpanMetricsProcessor);
  });

  it('wraps the SDK default sampler when neither config.sampler nor OTEL_TRACES_SAMPLER is set', () => {
    const prev = process.env.OTEL_TRACES_SAMPLER;
    delete process.env.OTEL_TRACES_SAMPLER;
    try {
      const out = withSpanMetrics<{ sampler?: Sampler; spanProcessors?: any[] }>({});
      // Nothing configured, so we resolve the SDK default (ParentBased(AlwaysOn)) and force-record it,
      // matching zero-code behavior instead of relying on the SDK default happening to be AlwaysOn.
      assert.ok(out.sampler instanceof AlwaysRecordSampler);
      assert.ok(out.spanProcessors![0] instanceof SpanMetricsProcessor);
    } finally {
      if (prev === undefined) delete process.env.OTEL_TRACES_SAMPLER;
      else process.env.OTEL_TRACES_SAMPLER = prev;
    }
  });

  it('B1: wraps the env-configured sampler when config.sampler is unset', () => {
    // Mode 2 users often configure sampling via OTEL_TRACES_SAMPLER instead of an explicit sampler.
    // withSpanMetrics must still force-record it, otherwise (e.g. always_off) it produces 0 metrics.
    const prev = process.env.OTEL_TRACES_SAMPLER;
    process.env.OTEL_TRACES_SAMPLER = 'always_off';
    try {
      const out = withSpanMetrics<{ sampler?: Sampler; spanProcessors?: any[] }>({});
      assert.ok(out.sampler instanceof AlwaysRecordSampler, 'env sampler must be force-record wrapped');
    } finally {
      if (prev === undefined) delete process.env.OTEL_TRACES_SAMPLER;
      else process.env.OTEL_TRACES_SAMPLER = prev;
    }
  });

  it('converts a lone traceExporter into a BatchSpanProcessor and removes traceExporter', () => {
    // NodeSDK ignores traceExporter once spanProcessors is set, so a traceExporter-only config must
    // be converted or the user's span export would be silently dropped.
    const exporter = new InMemorySpanExporter();
    const out = withSpanMetrics({ traceExporter: exporter } as any);
    assert.strictEqual(out.traceExporter, undefined, 'traceExporter must be removed so NodeSDK does not ignore it');
    assert.strictEqual(out.spanProcessors!.length, 2);
    assert.ok(out.spanProcessors![0] instanceof BatchSpanProcessor, 'exporter wrapped as BatchSpanProcessor');
    assert.ok(out.spanProcessors![1] instanceof SpanMetricsProcessor);
  });

  it('warns about and skips the deprecated singular spanProcessor', () => {
    const warn = sinon.stub(diag, 'warn');
    try {
      const existing = { onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: async () => {} };
      const out = withSpanMetrics({ spanProcessor: existing } as any);
      // Not carried into spanProcessors — only ours is added.
      assert.strictEqual(out.spanProcessors!.length, 1);
      assert.ok(out.spanProcessors![0] instanceof SpanMetricsProcessor);
      assert.ok(warn.calledOnce, 'a deprecation warning is logged');
    } finally {
      warn.restore();
    }
  });
});
