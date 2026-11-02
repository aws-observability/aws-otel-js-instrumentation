// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import * as holder from '../src/internal/open-telemetry-holder';

function realProvider(): MeterProvider {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3600000 });
  return new MeterProvider({ readers: [reader] });
}

describe('open-telemetry-holder provider resolution', () => {
  afterEach(() => {
    holder.resetForTest();
    metrics.disable(); // restore the global to the API noop provider
  });

  it('reports no provider before start (global is the noop provider)', () => {
    holder.resetForTest();
    metrics.disable();
    assert.strictEqual(holder.hasProvider(), false, 'noop global must not count as usable');
    assert.strictEqual(holder.get(), undefined);
  });

  it('falls back to the global MeterProvider once it is non-noop (no explicit bind)', () => {
    holder.resetForTest();
    const global = realProvider();
    metrics.setGlobalMeterProvider(global);
    assert.strictEqual(holder.hasProvider(), true, 'a real global provider must be usable');
    assert.strictEqual(holder.get(), global, 'get() must return the global provider when nothing is bound');
  });

  it('prefers an explicitly bound provider over the global one', () => {
    holder.resetForTest();
    const global = realProvider();
    metrics.setGlobalMeterProvider(global);
    const bound = realProvider();
    holder.set(bound);
    assert.strictEqual(holder.get(), bound, 'explicit bind must win over the global provider');
  });

  it('first bind wins; a later different bind is ignored', () => {
    holder.resetForTest();
    const first = realProvider();
    const second = realProvider();
    holder.set(first);
    holder.set(second);
    assert.strictEqual(holder.get(), first);
  });

  it('treats a global provider whose getMeter throws as unusable (does not propagate)', () => {
    holder.resetForTest();
    const hostile = {
      getMeter() {
        throw new Error('boom');
      },
    } as unknown as MeterProvider;
    metrics.setGlobalMeterProvider(hostile);
    assert.strictEqual(holder.hasProvider(), false, 'a throwing provider must be treated as unusable');
    assert.strictEqual(holder.get(), undefined);
  });
});
