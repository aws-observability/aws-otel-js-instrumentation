// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  MeterProvider,
} from '@opentelemetry/sdk-metrics';
import { Span } from '@opentelemetry/sdk-trace-base';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { SpanMetricsProcessor } from '../src/span-metrics-processor';
import { LIB_VERSION } from '../src/identity';
import * as holder from '../src/internal/open-telemetry-holder';
import { fakeSpan } from './test-utils';

const DURATION_BUCKETS = [0.002, 0.004, 0.006, 0.008, 0.01, 0.05, 0.1, 0.2, 0.4, 0.8, 1, 1.4, 2, 5, 10, 15];

describe('SpanMetricsProcessor', () => {
  let reader: PeriodicExportingMetricReader;
  let exporter: InMemoryMetricExporter;
  let processor: SpanMetricsProcessor;

  beforeEach(() => {
    holder.resetForTest();
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3600000 });
    const meterProvider = new MeterProvider({ readers: [reader] });
    holder.set(meterProvider);
    processor = new SpanMetricsProcessor();
  });

  afterEach(() => sinon.restore());

  async function collect() {
    const result = await reader.collect();
    return result.resourceMetrics.scopeMetrics.flatMap(sm => sm.metrics);
  }

  it('emits calls (empty unit, monotonic sum) and duration (seconds, connector buckets)', async () => {
    processor.onEnd(fakeSpan({ kind: SpanKind.SERVER, statusCode: SpanStatusCode.UNSET, durationSeconds: 0.005 }));

    const metrics = await collect();
    const calls = metrics.find(m => m.descriptor.name === 'traces.span.metrics.calls');
    const duration = metrics.find(m => m.descriptor.name === 'traces.span.metrics.duration');
    assert.ok(calls, 'calls metric missing');
    assert.ok(duration, 'duration metric missing');

    // calls: empty unit, sum = 1, short-form + marker attributes.
    assert.strictEqual(calls!.descriptor.unit, '');
    assert.strictEqual(calls!.dataPointType, DataPointType.SUM);
    const callsDp = calls!.dataPoints[0];
    assert.strictEqual(callsDp.value, 1);
    assert.strictEqual(callsDp.attributes['span.kind'], 'SERVER');
    assert.strictEqual(callsDp.attributes['status.code'], 'UNSET');
    assert.strictEqual(callsDp.attributes['aws.otel.span.metrics.schema'], 'v1');
    assert.strictEqual(callsDp.attributes['aws.otel.extension.lib.version'], LIB_VERSION);

    // duration: seconds unit, 0.005s recorded, connector default buckets.
    assert.strictEqual(duration!.descriptor.unit, 's');
    const durDp: any = duration!.dataPoints[0];
    assert.strictEqual(durDp.value.sum, 0.005);
    assert.deepStrictEqual(durDp.value.buckets.boundaries, DURATION_BUCKETS);
  });

  it('emits metrics under the cloudwatch.plugin.otel.span_metrics instrumentation scope', async () => {
    processor.onEnd(fakeSpan({}));
    const result = await reader.collect();
    const scope = result.resourceMetrics.scopeMetrics.find(sm =>
      sm.metrics.some(m => m.descriptor.name === 'traces.span.metrics.calls')
    );
    assert.ok(scope, 'scope emitting the calls metric not found');
    assert.strictEqual(scope!.scope.name, 'cloudwatch.plugin.otel.span_metrics');
  });

  it('does nothing (no throw) when no MeterProvider is bound yet', () => {
    holder.resetForTest();
    const p = new SpanMetricsProcessor();
    // Must not throw; simply skips until bound.
    p.onEnd(fakeSpan({}));
  });

  it('onEnd swallows exceptions so a bad span cannot break the pipeline', async () => {
    const bad = {
      get duration(): never {
        throw new Error('boom');
      },
    } as any;
    processor.onEnd(bad); // must not throw
  });

  it('onStart stamps schema and lib-version on the span when a MeterProvider is bound', () => {
    const setAttribute = sinon.spy();
    const span = { setAttribute } as unknown as Span;
    processor.onStart(span, {} as Context);
    assert.ok(setAttribute.calledWith('aws.otel.span.metrics.schema', 'v1'));
    assert.ok(setAttribute.calledWith('aws.otel.extension.lib.version', LIB_VERSION));
  });

  it('onStart does NOT stamp the dedup marker when no MeterProvider is bound', () => {
    // B2: onEnd cannot generate a metric without a provider (e.g. OTEL_METRICS_EXPORTER=none), so
    // marking the span would make the backend skip a span nobody metered — losing the metric.
    holder.resetForTest();
    const setAttribute = sinon.spy();
    const span = { setAttribute } as unknown as Span;
    new SpanMetricsProcessor().onStart(span, {} as Context);
    assert.ok(setAttribute.notCalled, 'must not stamp any attribute without a bound provider');
  });

  it('onStart swallows exceptions', () => {
    const span = {
      setAttribute: () => {
        throw new Error('boom');
      },
    } as unknown as Span;
    processor.onStart(span, {} as Context); // must not throw
  });
});
