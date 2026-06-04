// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { SampleRing } from '../../../src/serviceevents/profiler/sample-ring';

describe('SampleRing', function () {
  it('filters by time range inclusive', function () {
    const r = new SampleRing(10);
    r.add({ timestampNs: 100, frames: ['a(a.js:1)'] });
    r.add({ timestampNs: 150, frames: ['b(b.js:1)'] });
    r.add({ timestampNs: 200, frames: ['c(c.js:1)'] });
    r.add({ timestampNs: 250, frames: ['d(d.js:1)'] });
    const out = r.filterByTimeRange(150, 200);
    expect(out.map(s => s.frames[0])).toEqual(['b(b.js:1)', 'c(c.js:1)']);
  });

  it('filters by seq label', function () {
    const r = new SampleRing(10);
    r.add({ timestampNs: 1, frames: ['a'], seq: 5 });
    r.add({ timestampNs: 2, frames: ['b'], seq: 6 });
    r.add({ timestampNs: 3, frames: ['c'], seq: 5 });
    const out = r.filterBySeq(5);
    expect(out.length).toBe(2);
    expect(out.map(s => s.timestampNs)).toEqual([1, 3]);
  });

  it('wraps around once capacity is hit', function () {
    const r = new SampleRing(3);
    r.add({ timestampNs: 1, frames: [] });
    r.add({ timestampNs: 2, frames: [] });
    r.add({ timestampNs: 3, frames: [] });
    r.add({ timestampNs: 4, frames: [] });
    expect(r.length).toBe(3);
    const all = r.filterByTimeRange(0, 10);
    expect(all.map(s => s.timestampNs)).toEqual([2, 3, 4]);
  });

  it('clear empties the buffer', function () {
    const r = new SampleRing(3);
    r.add({ timestampNs: 1, frames: [] });
    r.clear();
    expect(r.length).toBe(0);
    expect(r.filterByTimeRange(0, 10)).toEqual([]);
  });
});
