// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { convertProfile } from '../../../src/serviceevents/profiler/profile-converter';

/**
 * Helper: build a minimal pprof-shaped SerializedProfile for unit tests.
 * String-table indexing is 1-based in real pprof but 0-based here — our
 * converter tolerates both by clamping via lookup; tests use 0-based.
 */
function buildProfile(spec: {
  stringTable: string[];
  functions: Array<{ id: number; name: number; filename?: number; startLine?: number }>;
  locations: Array<{ id: number; lines: Array<{ functionId: number; line: number }> }>;
  samples: Array<{ locationIds: number[]; seq?: number; seqAsNum?: boolean }>;
}): any {
  const seqKeyIdx = spec.stringTable.indexOf('seq');
  const strIndicesCache = new Map<string, number>();
  const table = [...spec.stringTable];
  function addStr(s: string): number {
    const found = strIndicesCache.get(s);
    if (found !== undefined) return found;
    const idx = table.length;
    table.push(s);
    strIndicesCache.set(s, idx);
    return idx;
  }

  const samples = spec.samples.map(s => {
    const label: any[] = [];
    if (s.seq !== undefined && seqKeyIdx >= 0) {
      if (s.seqAsNum) {
        label.push({ key: seqKeyIdx, num: s.seq });
      } else {
        label.push({ key: seqKeyIdx, str: addStr(String(s.seq)) });
      }
    }
    return { locationId: s.locationIds, value: [1], label };
  });

  return {
    stringTable: table,
    function: spec.functions,
    location: spec.locations.map(l => ({ id: l.id, line: l.lines })),
    sample: samples,
    timeNanos: 1_700_000_000 * 1_000_000_000,
  };
}

describe('convertProfile', function () {
  it('returns [] for empty / malformed input', function () {
    expect(convertProfile(null)).toEqual([]);
    expect(convertProfile(undefined)).toEqual([]);
    expect(convertProfile({} as any)).toEqual([]);
  });

  it('converts a single-sample profile into root→leaf frames', function () {
    // stringTable: 0="", 1="seq", 2="handler", 3="myapp/handler.js", 4="main", 5="myapp/main.js"
    const profile = buildProfile({
      stringTable: ['', 'seq', 'handler', 'myapp/handler.js', 'main', 'myapp/main.js'],
      functions: [
        { id: 1, name: 4, filename: 5, startLine: 1 }, // main
        { id: 2, name: 2, filename: 3, startLine: 1 }, // handler
      ],
      locations: [
        { id: 10, lines: [{ functionId: 1, line: 10 }] }, // main at line 10
        { id: 20, lines: [{ functionId: 2, line: 42 }] }, // handler at line 42
      ],
      // pprof stores locationId leaf→root; handler is leaf.
      samples: [{ locationIds: [20, 10], seq: 7 }],
    });

    const out = convertProfile(profile);
    expect(out.length).toBe(1);
    // Output should be root→leaf: main first, handler last.
    expect(out[0].frames).toEqual(['main(main.js:10)', 'handler(handler.js:42)']);
    expect(out[0].seq).toBe(7);
  });

  it('parses numeric seq labels', function () {
    const profile = buildProfile({
      stringTable: ['', 'seq', 'fn', 'file.js'],
      functions: [{ id: 1, name: 2, filename: 3, startLine: 1 }],
      locations: [{ id: 10, lines: [{ functionId: 1, line: 5 }] }],
      samples: [{ locationIds: [10], seq: 42, seqAsNum: true }],
    });
    const out = convertProfile(profile);
    expect(out[0].seq).toBe(42);
  });

  it('skips samples without locations', function () {
    const profile = buildProfile({
      stringTable: ['', 'seq'],
      functions: [],
      locations: [],
      samples: [{ locationIds: [] }],
    });
    expect(convertProfile(profile)).toEqual([]);
  });

  it('leaves seq undefined when no seq label present', function () {
    const profile = buildProfile({
      stringTable: ['', 'fn', 'file.js'],
      functions: [{ id: 1, name: 1, filename: 2, startLine: 1 }],
      locations: [{ id: 10, lines: [{ functionId: 1, line: 5 }] }],
      samples: [{ locationIds: [10] }],
    });
    const out = convertProfile(profile);
    expect(out[0].seq).toBeUndefined();
  });
});
