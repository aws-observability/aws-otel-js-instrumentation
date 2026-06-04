// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import { ProfilerCollector } from '../../../src/serviceevents/profiler/profiler-collector';
import { SampleRing } from '../../../src/serviceevents/profiler/sample-ring';
import { CompletedRequestsRing } from '../../../src/serviceevents/profiler/completed-requests';

/**
 * Integration-ish tests: stub the pprof engine via Object.defineProperty to feed
 * synthetic pprof Profile shapes through the rotation path. Validates the new
 * single-emit AggregateProfile path (spec §8 compressed wrapper).
 */

function buildCollector(sampleData: Array<{ frames: string[]; seq?: number; timestampNs: number }>) {
  const emitter = {
    emitOtlpProfile: sinon.spy(),
  };
  const completed = new CompletedRequestsRing(16);
  const sampleRing = new SampleRing(64);

  const collector = new ProfilerCollector({
    windowSeconds: 60,
    intervalMicros: 10_000,
    emitter: emitter as any,
    completedRequests: completed,
    sampleRing,
  });

  // Simulate pprof being ready without actually loading the native dep.
  (collector as any).__test_setReady(true);

  // Build a fake SerializedProfile from sampleData.
  const stringTable = ['', 'seq'];
  const functionTable: any[] = [];
  const locationTable: any[] = [];
  const samples: any[] = [];
  const strIdx = (s: string): number => {
    const existing = stringTable.indexOf(s);
    if (existing >= 0) return existing;
    stringTable.push(s);
    return stringTable.length - 1;
  };
  for (const s of sampleData) {
    const locIds: number[] = [];
    // pprof stores leaf→root; push frames in reverse so the converter emits root→leaf.
    for (let i = s.frames.length - 1; i >= 0; i--) {
      const frame = s.frames[i];
      const [name, rest] = frame.split('(');
      const [file, lineStr] = (rest ?? '').replace(')', '').split(':');
      const fnId = functionTable.length + 1;
      functionTable.push({
        id: fnId,
        name: strIdx(name),
        systemName: strIdx(name),
        filename: strIdx(file),
        startLine: 1,
      });
      const locId = locationTable.length + 1;
      locationTable.push({ id: locId, line: [{ functionId: fnId, line: Number(lineStr) || 1 }] });
      locIds.push(locId);
    }
    const label: any[] = [];
    if (s.seq !== undefined) {
      label.push({ key: strIdx('seq'), str: strIdx(String(s.seq)) });
    }
    samples.push({ locationId: locIds, value: [1], label });
  }
  const fakeProfile = {
    stringTable,
    function: functionTable,
    location: locationTable,
    sample: samples,
    timeNanos: 1_700_000_000 * 1_000_000_000,
    durationNanos: 60 * 1_000_000_000,
  };

  const wall = (collector as any).wall;
  wall.rotate = () => fakeProfile;

  return { collector, emitter, completed, sampleRing };
}

describe('ProfilerCollector', function () {
  // Allow zstd-codec WASM init time on first run.
  this.timeout(15_000);

  // Helper to wait for the fire-and-forget serializeCompressed promise inside collect().
  const flushPromises = () => new Promise(resolve => setImmediate(resolve));

  it('skips emit when no samples carry trace or operation attribution', async function () {
    // Samples have neither seq nor a matching CompletedRequest → all dropped at filter.
    const { collector, emitter } = buildCollector([
      { frames: ['app.a(a.js:1)', 'app.b(b.js:2)'], timestampNs: 1 },
      { frames: ['app.a(a.js:1)', 'app.c(c.js:3)'], timestampNs: 2 },
    ]);
    (collector as any).__test_collect();
    await flushPromises();
    expect(emitter.emitOtlpProfile.callCount).toBe(0);
  });

  it('emits a single compressed wrapper when samples have an attributed seq', async function () {
    const { collector, emitter, completed } = buildCollector([
      { frames: ['app.a(a.js:1)', 'app.b(b.js:2)'], seq: 7, timestampNs: 1 },
      { frames: ['app.a(a.js:1)', 'app.c(c.js:3)'], seq: 7, timestampNs: 2 },
      // Untracked sample (no seq) — should be filtered out at serialize time.
      { frames: ['app.a(a.js:1)', 'app.d(d.js:4)'], timestampNs: 3 },
    ]);
    completed.push({
      seq: 7,
      startNs: 0,
      endNs: 1_000,
      operation: 'GET /users/:id',
      traceId: 'abc',
      spanId: 's1',
    });

    (collector as any).__test_collect();
    // collect() kicks off an async serializeCompressed promise; wait for it.
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(emitter.emitOtlpProfile.callCount).toBe(1);
    const wrapper = emitter.emitOtlpProfile.firstCall.args[0];
    expect(wrapper.encoding).toBe('zstd');
    expect(typeof wrapper.data).toBe('string');
    // Trace + operation surfaced from the attributed samples.
    expect(wrapper.trace_links).toEqual([{ trace_id: 'abc', span_id: 's1' }]);
    expect(wrapper.operations).toEqual(['GET /users/:id']);
  });

  it('drops samples when no pprof profile was produced', async function () {
    const { collector, emitter } = buildCollector([]);
    (collector as any).wall.rotate = () => null;
    (collector as any).__test_collect();
    await flushPromises();
    expect(emitter.emitOtlpProfile.callCount).toBe(0);
  });

  it('skips start when running in Lambda', function () {
    const original = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-fn';
    try {
      const collector = new ProfilerCollector({
        windowSeconds: 60,
        intervalMicros: 10_000,
        emitter: null,
        completedRequests: new CompletedRequestsRing(4),
        sampleRing: new SampleRing(4),
      });
      collector.start();
      expect(collector.isRunning()).toBe(false);
      collector.stop();
    } finally {
      if (original === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      else process.env.AWS_LAMBDA_FUNCTION_NAME = original;
    }
  });
});
