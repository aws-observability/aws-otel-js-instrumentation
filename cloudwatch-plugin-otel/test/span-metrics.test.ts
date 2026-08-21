// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  Sampler,
} from '@opentelemetry/sdk-trace-base';
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
    const existing = { onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: async () => {} };
    const config = { sampler: new AlwaysOnSampler() as Sampler, spanProcessors: [existing] as any[] };
    const out = withSpanMetrics(config);
    assert.ok(out.sampler instanceof AlwaysRecordSampler);
    assert.strictEqual(out.spanProcessors!.length, 2);
    assert.strictEqual(out.spanProcessors![0], existing);
    assert.ok(out.spanProcessors![1] instanceof SpanMetricsProcessor);
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
      const out = withSpanMetrics({ traceExporter: new InMemorySpanExporter() } as any);
      // Sampler unconfigured, so we resolve the SDK default (ParentBased(AlwaysOn)) and force-record
      // it, matching zero-code behavior instead of relying on the SDK default happening to be AlwaysOn.
      assert.ok(out.sampler instanceof AlwaysRecordSampler);
      assert.ok(out.spanProcessors!.some((p: unknown) => p instanceof SpanMetricsProcessor));
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
      const out = withSpanMetrics({ traceExporter: new InMemorySpanExporter() } as any);
      assert.ok(out.sampler instanceof AlwaysRecordSampler, 'env sampler must be force-record wrapped');
    } finally {
      if (prev === undefined) delete process.env.OTEL_TRACES_SAMPLER;
      else process.env.OTEL_TRACES_SAMPLER = prev;
    }
  });

  it('aborts untouched when the config has no trace output at all (env/default export case)', () => {
    // NodeSDK wires span export from env/defaults ONLY when processors are not explicitly
    // configured. Setting spanProcessors = [ours] here would make NodeSDK skip that wiring and
    // silently drop all span export while 100% metrics masked the loss — so withSpanMetrics must
    // give itself up: warn, and leave the config completely untouched (sampler included: force-
    // recording spans that no processor consumes would only add overhead).
    const warn = sinon.stub(diag, 'warn');
    try {
      const config: { sampler?: Sampler; spanProcessors?: any[] } = {};
      const out = withSpanMetrics(config);
      assert.strictEqual(out, config);
      assert.ok(!('spanProcessors' in out), 'spanProcessors must not be set (NodeSDK env wiring must run)');
      assert.strictEqual(out.sampler, undefined, 'sampler must stay unwrapped on the abort path');
      assert.ok(warn.calledOnce, 'the disabled state must be announced');
      assert.ok(String(warn.firstCall.args[0]).includes('DISABLED'), 'abort warn must state metrics are disabled');
    } finally {
      warn.restore();
    }
  });

  it('R2: empty spanProcessors becomes the metrics-only recipe ([ours], sampler wrapped, warn)', () => {
    // A defined-but-empty spanProcessors means the user disabled trace export (NodeSDK wires no
    // export and no env fallback for a truthy empty array). Appending only our processor cannot
    // lose any export — there is none — and delivers span metrics without trace export.
    const warn = sinon.stub(diag, 'warn');
    try {
      const config: { sampler?: Sampler; spanProcessors: any[] } = { spanProcessors: [] };
      const out = withSpanMetrics(config);
      assert.strictEqual(out.spanProcessors.length, 1);
      assert.ok(out.spanProcessors[0] instanceof SpanMetricsProcessor);
      assert.ok(out.sampler instanceof AlwaysRecordSampler, 'sampler wrapped so 100% of spans are metered');
      assert.ok(warn.calledOnce, 'the recorded-not-exported tradeoff must be announced');
      assert.ok(String(warn.firstCall.args[0]).includes('not exported'), 'R2 warn must state the tradeoff');
    } finally {
      warn.restore();
    }
  });

  it('R6: null trace-output fields count as absent — the abort still fires (no export drop, no crash)', () => {
    // null is not a "disable" signal in any NodeSDK version: it falls through the precedence chain
    // exactly like an absent field. So a config whose only trace fields are null must take the same
    // abort as an empty config — NOT produce spanProcessors=[ours] (which would kill env export).
    const warn = sinon.stub(diag, 'warn');
    try {
      const config = { traceExporter: null, spanProcessor: null, spanProcessors: null } as any;
      const out = withSpanMetrics(config);
      assert.strictEqual(out, config);
      assert.deepStrictEqual(out.spanProcessors, null, 'config untouched: null fields left as-is');
      assert.strictEqual(out.sampler, undefined, 'sampler must stay unwrapped on the abort path');
      assert.ok(warn.calledOnce);
    } finally {
      warn.restore();
    }
  });

  it('R6: null spanProcessors falls through to a real traceExporter (no crash, export preserved)', () => {
    const exporter = new InMemorySpanExporter();
    const out = withSpanMetrics({ spanProcessors: null, traceExporter: exporter } as any);
    assert.strictEqual(out.spanProcessors!.length, 2);
    assert.ok(out.spanProcessors![0] instanceof BatchSpanProcessor, "user's exporter survives, wrapped");
    assert.ok(out.spanProcessors![1] instanceof SpanMetricsProcessor);
  });

  it('R1+I3: a traceExporter losing to spanProcessors is deleted and warned about', () => {
    const warn = sinon.stub(diag, 'warn');
    try {
      const existing = { onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: async () => {} };
      const exporter = new InMemorySpanExporter();
      const out = withSpanMetrics({ spanProcessors: [existing], traceExporter: exporter } as any);
      assert.strictEqual(out.traceExporter, undefined, 'losing exporter must not dangle');
      assert.strictEqual(out.spanProcessors!.length, 2);
      assert.ok(warn.calledOnce, 'the dropped exporter must be announced');
    } finally {
      warn.restore();
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

  it('the wrapped batch processor exports through the USER exporter (export path preserved)', async () => {
    // The invariant that matters: the resulting config still carries the user's export path, not
    // merely our processor. Proven behaviorally — a span pushed through the batch processor must
    // land in the user's exporter — rather than by reaching into SDK-private fields.
    const exporter = new InMemorySpanExporter();
    const out = withSpanMetrics({ traceExporter: exporter } as any);
    const batch = out.spanProcessors![0] as BatchSpanProcessor;
    const provider = new BasicTracerProvider({ spanProcessors: [batch] });
    provider.getTracer('t').startSpan('probe').end();
    await batch.forceFlush();
    assert.strictEqual(exporter.getFinishedSpans().length, 1, "span must reach the user's exporter");
    assert.strictEqual(exporter.getFinishedSpans()[0].name, 'probe');
    await provider.shutdown();
  });

  it('converts the deprecated singular spanProcessor into spanProcessors (with a warning)', () => {
    // NodeSDK still honors the singular option (deprecated since 0.51.0); ignoring it here would
    // silently drop the user's span export once we set spanProcessors (plural wins in NodeSDK).
    const warn = sinon.stub(diag, 'warn');
    try {
      const existing = { onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: async () => {} };
      const out = withSpanMetrics({ spanProcessor: existing } as any);
      assert.strictEqual(out.spanProcessors!.length, 2);
      assert.strictEqual(out.spanProcessors![0], existing, "the user's processor must be carried over first");
      assert.ok(out.spanProcessors![1] instanceof SpanMetricsProcessor);
      assert.strictEqual(out.spanProcessor, undefined, 'singular option must be removed, not left dangling');
      assert.ok(warn.calledOnce, 'a deprecation warning is logged');
    } finally {
      warn.restore();
    }
  });

  it('lets spanProcessors win over the singular spanProcessor (NodeSDK precedence)', () => {
    const warn = sinon.stub(diag, 'warn');
    try {
      const plural = { onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: async () => {} };
      const singular = { onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: async () => {} };
      const out = withSpanMetrics({ spanProcessors: [plural], spanProcessor: singular } as any);
      assert.strictEqual(out.spanProcessors!.length, 2);
      assert.strictEqual(out.spanProcessors![0], plural);
      assert.ok(out.spanProcessors![1] instanceof SpanMetricsProcessor);
      assert.ok(!out.spanProcessors!.includes(singular), 'singular loses to plural, as in NodeSDK');
      // The losing singular is deleted (so NodeSDK cannot warn about an option that had no effect)
      // and the drop is announced, since the user's processor is being ignored.
      assert.strictEqual(out.spanProcessor, undefined, 'losing singular must be removed');
      assert.ok(warn.calledOnce, 'the silent drop of the singular processor must be warned about');
    } finally {
      warn.restore();
    }
  });
});
