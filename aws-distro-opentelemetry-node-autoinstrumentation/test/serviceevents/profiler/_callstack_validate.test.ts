// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import expect from 'expect';
import { OtlpProfileBuilder, FrameInfo } from '../../../src/serviceevents/profiler/otlp-profile-builder';

function _num(v: any): number | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'number' ? v : Number(v);
}

describe('Callstack semantic correctness (JS)', function () {
  this.timeout(15_000);

  it('walks pprof leaf→root locations and produces root→leaf frames', function () {
    // Build a fake pprof Profile representing this call chain (leaf → root):
    //   deepest <- level_3 <- level_2 <- level_1 <- root_caller
    const stringTable = ['', 'seq'];
    const fns: any[] = [];
    const locs: any[] = [];
    function strIdx(s: string): number {
      const i = stringTable.indexOf(s);
      if (i >= 0) return i;
      stringTable.push(s);
      return stringTable.length - 1;
    }
    function makeLoc(name: string, file: string, line: number, startLine: number): number {
      const fnId = fns.length + 1;
      fns.push({ id: fnId, name: strIdx(name), systemName: strIdx(name), filename: strIdx(file), startLine });
      const locId = locs.length + 1;
      locs.push({ id: locId, line: [{ functionId: fnId, line }] });
      return locId;
    }
    // pprof native order (leaf-first):
    const leaf = makeLoc('deepest', '/app/test.js', 19, 17);
    const l3 = makeLoc('level_3', '/app/test.js', 25, 24);
    const l2 = makeLoc('level_2', '/app/test.js', 28, 27);
    const l1 = makeLoc('level_1', '/app/test.js', 31, 30);
    const root = makeLoc('root_caller', '/app/test.js', 34, 33);
    const profile = {
      stringTable,
      function: fns,
      location: locs,
      sample: [{ locationId: [leaf, l3, l2, l1, root], value: [1] }],
      timeNanos: 1_700_000_000 * 1_000_000_000,
    };

    // Replicate the collector's walk
    const locations = new Map<number, any>();
    for (const loc of profile.location) locations.set(loc.id, loc);
    const functions = new Map<number, any>();
    for (const fn of profile.function) functions.set(fn.id, fn);

    const sample = profile.sample[0];
    const frames: FrameInfo[] = [];
    // Reverse pprof's leaf→root to get root→leaf, matching profiler-collector.ts
    for (let i = sample.locationId.length - 1; i >= 0; i--) {
      const loc = locations.get(sample.locationId[i])!;
      for (let j = loc.line.length - 1; j >= 0; j--) {
        const line = loc.line[j];
        const fn = functions.get(line.functionId)!;
        frames.push({
          methodName: stringTable[_num(fn.name)!],
          qualifiedName: stringTable[_num(fn.systemName)!] || stringTable[_num(fn.name)!],
          fileName: stringTable[_num(fn.filename)!],
          lineNumber: _num(line.line) ?? 0,
          startLine: _num(fn.startLine) ?? 0,
        });
      }
    }

    // Expected: root → leaf
    const got = frames.map(f => f.qualifiedName);
    expect(got).toEqual(['root_caller', 'level_1', 'level_2', 'level_3', 'deepest']);

    // Line numbers should be call-sites (not declaration lines)
    const lineNumbers = frames.map(f => f.lineNumber);
    expect(lineNumbers).toEqual([34, 31, 28, 25, 19]);

    // start_line is the function declaration line
    const startLines = frames.map(f => f.startLine);
    expect(startLines).toEqual([33, 30, 27, 24, 17]);
  });

  it('feeds correctly into OtlpProfileBuilder so the dictionary preserves order', async function () {
    const builder = new OtlpProfileBuilder(1000, 60_000_000_000, 10_000_000);
    const frames: FrameInfo[] = [
      { methodName: 'a', qualifiedName: 'mod.a', fileName: 'a.js', lineNumber: 10, startLine: 1 },
      { methodName: 'b', qualifiedName: 'mod.b', fileName: 'b.js', lineNumber: 20, startLine: 1 },
      { methodName: 'c', qualifiedName: 'mod.c', fileName: 'c.js', lineNumber: 30, startLine: 1 },
    ];
    builder.addSample({ frames, timestampNs: 1_500_000, operation: 'GET /x' });
    const profile = builder.serialize() as any;
    const stack = profile.stack_table[1].location_indices;
    expect(stack.length).toBe(3);

    const resolved = stack.map((locIdx: number) => {
      const loc = profile.location_table[locIdx];
      const func = profile.function_table[loc.lines[0].function_index];
      return profile.string_table[func.system_name_strindex];
    });
    expect(resolved).toEqual(['mod.a', 'mod.b', 'mod.c']);
  });
});
