// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the full `service.function.duration` histogram
 * wiring path (JS parity with Python's TestHistogramWiringIntegration /
 * TestSamplingAwareHistogramWiring):
 *
 * 1. Create a real MeterProvider + InMemoryMetricExporter (mirrors
 *    production setup in ServiceEventsOtlpEmitter).
 * 2. Create a `service.function.duration` histogram on the meter with the
 *    EXPONENTIAL_HISTOGRAM aggregation View.
 * 3. Wire it into `ServiceEventsMonitorState` via setFunctionDurationHistogram().
 * 4. Drive `__serviceeventsMonitorEnter` / `__serviceeventsMonitorExit` directly.
 * 5. Read the metric data back through the in-memory exporter and assert
 *    attributes, durations, and status values.
 *
 * These tests catch wiring regressions that the helper-based contract
 * tests cannot — for example, if `__serviceeventsMonitorExit` stops calling
 * `recordFunctionCallMetrics()`, or `setFunctionDurationHistogram()` forgets
 * to store base attrs.
 */

import expect from 'expect';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  AggregationType,
  InMemoryMetricExporter,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { AggregationOption, ResourceMetrics, ViewOptions } from '@opentelemetry/sdk-metrics';

import {
  ServiceEventsMonitorState,
  __serviceeventsMonitorEnter,
  __serviceeventsMonitorExit,
  resetMonitorState,
  setSamplingMode,
} from '../../src/serviceevents/serviceevents-monitor';

const HISTOGRAM_NAME = 'service.function.duration';

interface HarnessHandles {
  meterProvider: MeterProvider;
  exporter: InMemoryMetricExporter;
  reader: PeriodicExportingMetricReader;
  state: ServiceEventsMonitorState;
}

async function setupHarness(): Promise<HarnessHandles> {
  resetMonitorState();
  setSamplingMode('always');

  const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  // 1h export interval so we control flushing manually via forceFlush().
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60 * 60 * 1000,
  });

  const view: ViewOptions = {
    instrumentName: HISTOGRAM_NAME,
    aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM },
  };

  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'wiring-test' }),
    readers: [reader],
    views: [view],
  });

  const meter = meterProvider.getMeter('aws.service_events', '1.0');
  const histogram = meter.createHistogram(HISTOGRAM_NAME, {
    unit: 'Microseconds',
    description: 'Function call duration',
  });

  const state = ServiceEventsMonitorState.getInstance();
  state.setMetricBaseAttrs({ 'Telemetry.Source': 'ServiceEvents' });
  state.setFunctionDurationHistogram(histogram);

  return { meterProvider, exporter, reader, state };
}

async function getDurationMetric(handles: HarnessHandles): Promise<{ metric: any; scope: any } | null> {
  await handles.meterProvider.forceFlush();
  const all: ResourceMetrics[] = handles.exporter.getMetrics();
  for (const rm of all) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === HISTOGRAM_NAME) {
          return { metric: m, scope: sm.scope };
        }
      }
    }
  }
  return null;
}

function dataPointsByFunction(metric: any, functionName: string): any[] {
  return metric.dataPoints.filter((dp: any) => dp.attributes['function.name'] === functionName);
}

async function shutdownHarness(handles: HarnessHandles): Promise<void> {
  await handles.meterProvider.shutdown();
  resetMonitorState();
}

describe('ServiceEventsMonitor — histogram wiring integration', function () {
  let handles: HarnessHandles;

  beforeEach(async function () {
    handles = await setupHarness();
  });

  afterEach(async function () {
    await shutdownHarness(handles);
  });

  it('setFunctionDurationHistogram populates state used by __exit', function () {
    expect(handles.state.hasFunctionDurationHistogram()).toBe(true);
  });

  it('records a sampled call as status=success with no exception.type attribute', async function () {
    const ctx = __serviceeventsMonitorEnter('mod.func_success');
    expect(ctx).not.toBeNull();
    __serviceeventsMonitorExit(ctx!);

    const found = await getDurationMetric(handles);
    expect(found).not.toBeNull();
    const { metric, scope } = found!;
    expect(scope.name).toBe('aws.service_events');
    expect(metric.descriptor.unit).toBe('Microseconds');

    const dps = dataPointsByFunction(metric, 'mod.func_success');
    expect(dps.length).toBe(1);
    const attrs = dps[0].attributes;
    expect(attrs.status).toBe('success');
    expect(attrs['Telemetry.Source']).toBe('ServiceEvents');
    // service.name + environment ride along on the Resource, not per-call attrs.
    expect(attrs['service.name']).toBeUndefined();
    expect(attrs.environment).toBeUndefined();
    expect(attrs['exception.type']).toBeUndefined();
    expect(dps[0].value.count).toBe(1);
  });

  it('aggregates multiple calls into one data point with count=N', async function () {
    for (let i = 0; i < 5; i++) {
      const ctx = __serviceeventsMonitorEnter('mod.repeated');
      __serviceeventsMonitorExit(ctx!);
    }

    const found = await getDurationMetric(handles);
    expect(found).not.toBeNull();
    const dps = dataPointsByFunction(found!.metric, 'mod.repeated');
    expect(dps.length).toBe(1);
    expect(dps[0].value.count).toBe(5);
  });

  it('updates _aggregations when histogram is detached (covers EMF-only path)', async function () {
    handles.state.setFunctionDurationHistogram(null);

    const ctx = __serviceeventsMonitorEnter('mod.fallback');
    __serviceeventsMonitorExit(ctx!);

    // Histogram should have NO data point for this function.
    const found = await getDurationMetric(handles);
    if (found !== null) {
      const dps = dataPointsByFunction(found.metric, 'mod.fallback');
      expect(dps.length).toBe(0);
    }
    // Aggregations should have been populated.
    const aggregations = handles.state.getAndSwapAggregations();
    expect(aggregations.has('mod.fallback')).toBe(true);
    const opMap = aggregations.get('mod.fallback')!;
    let totalCount = 0;
    for (const bucket of opMap.values()) {
      totalCount += bucket.count;
    }
    expect(totalCount).toBe(1);
  });
});

describe('ServiceEventsMonitor — sampling-aware histogram wiring', function () {
  let handles: HarnessHandles;

  beforeEach(async function () {
    handles = await setupHarness();
  });

  afterEach(async function () {
    await shutdownHarness(handles);
  });

  it("records nothing into the histogram in 'never' mode", async function () {
    setSamplingMode('never');

    for (let i = 0; i < 7; i++) {
      const ctx = __serviceeventsMonitorEnter('mod.never_sampled');
      // ctx is null in 'never' mode; __exit must safely no-op.
      __serviceeventsMonitorExit(ctx);
    }

    const found = await getDurationMetric(handles);
    if (found !== null) {
      const dps = dataPointsByFunction(found.metric, 'mod.never_sampled');
      expect(dps.length).toBe(0);
    }
  });

  it('skips SEH aggregation when histogram is wired (histogram is the source of truth)', async function () {
    // When the OTel histogram is wired it becomes the sole function-call signal.
    // SEH/EMF aggregation is skipped — call_count, caller_map, and exception_name 
    // are not emitted via `aws.service_events.function_call` LogRecords on this path.
    // Mirrors the Python `record_function_call_metrics` -> bool contract.
    setSamplingMode('never');

    const ctx = __serviceeventsMonitorEnter('mod.no_double_path');
    __serviceeventsMonitorExit(ctx);

    // Histogram should NOT have a data point (call wasn't sampled).
    const found = await getDurationMetric(handles);
    if (found !== null) {
      const dps = dataPointsByFunction(found.metric, 'mod.no_double_path');
      expect(dps.length).toBe(0);
    }

    // SEH/EMF aggregations should also be empty — skipped while histogram
    // is wired regardless of sampling decision.
    const aggregations = handles.state.getAndSwapAggregations();
    expect(aggregations.has('mod.no_double_path')).toBe(false);
  });

  it('histogram count tracks the sampled subset, not total invocations', async function () {
    // 3 sampled calls
    setSamplingMode('always');
    for (let i = 0; i < 3; i++) {
      const ctx = __serviceeventsMonitorEnter('mod.mixed');
      __serviceeventsMonitorExit(ctx!);
    }

    // 5 non-sampled calls
    setSamplingMode('never');
    for (let i = 0; i < 5; i++) {
      const ctx = __serviceeventsMonitorEnter('mod.mixed');
      __serviceeventsMonitorExit(ctx);
    }

    const found = await getDurationMetric(handles);
    expect(found).not.toBeNull();
    const dps = dataPointsByFunction(found!.metric, 'mod.mixed');
    let total = 0;
    for (const dp of dps) {
      total += dp.value.count;
    }
    expect(total).toBe(3);
  });
});

// Production wires EXPONENTIAL_HISTOGRAM aggregation through the exporter's
// `selectAggregation` (consumed by `PeriodicExportingMetricReader`) rather
// than through a MeterProvider `View`. Mirror that wiring here so the test
// catches regressions in either mechanism.
class ExponentialHistogramExporter extends InMemoryMetricExporter {
  selectAggregation(instrumentType: InstrumentType): AggregationOption {
    if (instrumentType === InstrumentType.HISTOGRAM) {
      return { type: AggregationType.EXPONENTIAL_HISTOGRAM };
    }
    return { type: AggregationType.DEFAULT };
  }
}

describe('ServiceEventsMonitor — exporter aggregationPreference parity', function () {
  let handles: HarnessHandles;

  beforeEach(async function () {
    resetMonitorState();
    setSamplingMode('always');

    const exporter = new ExponentialHistogramExporter(AggregationTemporality.DELTA);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60 * 60 * 1000,
    });

    // No `views` here — aggregation must come from the exporter's
    // `selectAggregation`, matching `ServiceEventsOtlpEmitter`'s production
    // wiring (`aggregationPreference: serviceEventsAggregationSelector`).
    const meterProvider = new MeterProvider({
      resource: resourceFromAttributes({ 'service.name': 'wiring-test' }),
      readers: [reader],
    });

    const meter = meterProvider.getMeter('aws.service_events', '1.0');
    const histogram = meter.createHistogram(HISTOGRAM_NAME, {
      unit: 'Microseconds',
      description: 'Function call duration',
    });

    const state = ServiceEventsMonitorState.getInstance();
    state.setMetricBaseAttrs({ 'Telemetry.Source': 'ServiceEvents' });
    state.setFunctionDurationHistogram(histogram);

    handles = { meterProvider, exporter, reader, state };
  });

  afterEach(async function () {
    await shutdownHarness(handles);
  });

  it('produces exponential histogram data points via selectAggregation (no View)', async function () {
    for (let i = 0; i < 5; i++) {
      const ctx = __serviceeventsMonitorEnter('mod.exporter_pref');
      __serviceeventsMonitorExit(ctx!);
    }

    const found = await getDurationMetric(handles);
    expect(found).not.toBeNull();
    const { metric } = found!;

    // Exponential histograms expose `scale` + `positive`/`negative` buckets
    // on each data point. Explicit-bucket histograms expose `boundaries` +
    // `buckets`. Asserting on the shape catches a silent fall-back to
    // explicit-bucket aggregation if the exporter preference is ignored.
    const dps = dataPointsByFunction(metric, 'mod.exporter_pref');
    expect(dps.length).toBe(1);
    const v = dps[0].value;
    expect(v).toHaveProperty('scale');
    expect(v).toHaveProperty('positive');
    expect(v).not.toHaveProperty('boundaries');
    expect(v.count).toBe(5);
  });
});
