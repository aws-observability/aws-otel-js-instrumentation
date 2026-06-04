// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  OtlpProfileBuilder,
  FrameInfo,
  CompressedProfileWrapper,
} from '../../../src/serviceevents/profiler/otlp-profile-builder';

const FRAME_RUN: FrameInfo = {
  methodName: 'run',
  qualifiedName: 'threading.Thread.run',
  fileName: 'threading.js',
  lineNumber: 975,
  startLine: 970,
};
const FRAME_HANDLE: FrameInfo = {
  methodName: 'handle',
  qualifiedName: 'myapp.UserController.handle',
  fileName: 'user_controller.js',
  lineNumber: 42,
  startLine: 40,
};
const FRAME_QUERY: FrameInfo = {
  methodName: 'query',
  qualifiedName: 'myapp.db.UserRepository.query',
  fileName: 'user_repository.js',
  lineNumber: 88,
  startLine: 85,
};

interface InnerProfile {
  sample_type: { type_strindex: number; unit_strindex: number };
  period_type: { type_strindex: number; unit_strindex: number };
  time_unix_nano: number;
  duration_nano: number;
  period: number;
  profile_id: string;
  string_table: string[];
  function_table: Array<{
    name_strindex: number;
    system_name_strindex: number;
    filename_strindex: number;
    start_line: number;
  }>;
  location_table: Array<{ lines: Array<{ function_index: number; line: number }> }>;
  stack_table: Array<{ location_indices: number[] }>;
  link_table: Array<{ trace_id: string; span_id: string }>;
  attribute_table: Array<{ key_strindex: number; value_strindex: number }>;
  samples: Array<{
    stack_index: number;
    timestamps_unix_nano?: number;
    time_offset_ms?: number;
    link_index?: number;
    attribute_indices?: number[];
  }>;
}

async function decompressWrapper(wrapper: CompressedProfileWrapper): Promise<InnerProfile> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ZstdCodec } = require('zstd-codec');
  return new Promise((resolve, reject) => {
    ZstdCodec.run((zstd: { Simple: new () => { decompress(b: Uint8Array): Uint8Array } }) => {
      try {
        const compressed = Buffer.from(wrapper.data, 'base64');
        const simple = new zstd.Simple();
        const decompressed = simple.decompress(compressed);
        resolve(JSON.parse(Buffer.from(decompressed).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
  });
}

describe('OtlpProfileBuilder', function () {
  // zstd-codec WASM init takes a moment on first run.
  this.timeout(15_000);

  describe('Sentinels and well-known strings', function () {
    let profile: InnerProfile;
    beforeEach(function () {
      const b = new OtlpProfileBuilder(1_000_000_000_000_000_000, 60_000_000_000, 10_000_000);
      profile = b.serialize() as unknown as InnerProfile;
    });

    it('string_table[0] is empty string', function () {
      expect(profile.string_table[0]).toBe('');
    });

    it('well-known strings at indices 1-4', function () {
      expect(profile.string_table[1]).toBe('wall');
      expect(profile.string_table[2]).toBe('nanoseconds');
      expect(profile.string_table[3]).toBe('thread.name');
      expect(profile.string_table[4]).toBe('operation');
    });

    it('function_table[0] sentinel', function () {
      expect(profile.function_table[0]).toEqual({
        name_strindex: 0,
        system_name_strindex: 0,
        filename_strindex: 0,
        start_line: 0,
      });
    });

    it('location_table[0] sentinel', function () {
      expect(profile.location_table[0].lines).toEqual([{ function_index: 0, line: 0 }]);
    });

    it('stack_table[0] sentinel', function () {
      expect(profile.stack_table[0].location_indices).toEqual([0]);
    });

    it('link_table[0] sentinel', function () {
      expect(profile.link_table[0]).toEqual({ trace_id: '', span_id: '' });
    });

    it('attribute_table[0] sentinel', function () {
      expect(profile.attribute_table[0]).toEqual({ key_strindex: 0, value_strindex: 0 });
    });

    it('sample_type and period_type use well-known strings', function () {
      expect(profile.sample_type).toEqual({ type_strindex: 1, unit_strindex: 2 });
      expect(profile.period_type).toEqual({ type_strindex: 1, unit_strindex: 2 });
    });

    it('profile_id is 32-char hex (uuid no dashes)', function () {
      expect(profile.profile_id.length).toBe(32);
      expect(profile.profile_id).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('Dictionary deduplication', function () {
    it('same string interned twice keeps table size', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 100, threadName: 'w', operation: 'GET /a' });
      const sizeAfterFirst = (b.serialize() as unknown as InnerProfile).string_table.length;
      b.addSample({ frames: [FRAME_RUN], timestampNs: 200, threadName: 'w', operation: 'GET /a' });
      const sizeAfterSecond = (b.serialize() as unknown as InnerProfile).string_table.length;
      expect(sizeAfterFirst).toBe(sizeAfterSecond);
    });

    it('identical stacks dedup; sample count grows', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      for (const ts of [100, 200, 300, 400]) {
        b.addSample({ frames: [FRAME_RUN, FRAME_HANDLE, FRAME_QUERY], timestampNs: ts, operation: 'GET /a' });
      }
      const p = b.serialize() as unknown as InnerProfile;
      expect(p.stack_table.length).toBe(2); // sentinel + 1
      expect(b.getUniqueStackCount()).toBe(2);
      expect(b.getSampleCount()).toBe(4);
    });

    it('different stacks distinct', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN, FRAME_HANDLE], timestampNs: 100, operation: 'GET /a' });
      b.addSample({ frames: [FRAME_RUN, FRAME_HANDLE, FRAME_QUERY], timestampNs: 200, operation: 'GET /a' });
      b.addSample({ frames: [FRAME_RUN, FRAME_QUERY], timestampNs: 300, operation: 'GET /a' });
      expect(b.getUniqueStackCount()).toBe(4); // sentinel + 3
    });

    it('different call site of same function makes distinct location', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      const f1: FrameInfo = { ...FRAME_QUERY, lineNumber: 88 };
      const f2: FrameInfo = { ...FRAME_QUERY, lineNumber: 99 };
      b.addSample({ frames: [FRAME_RUN, f1], timestampNs: 100, operation: 'GET /a' });
      b.addSample({ frames: [FRAME_RUN, f2], timestampNs: 200, operation: 'GET /a' });
      const p = b.serialize() as unknown as InnerProfile;
      // function_table: sentinel + RUN + query = 3 (one function only)
      expect(p.function_table.length).toBe(3);
      // location_table: sentinel + RUN's loc + 2 query locs (different lines)
      expect(p.location_table.length).toBe(4);
    });
  });

  describe('Link table', function () {
    it('same trace+span dedups', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 100, traceId: 'abc', spanId: 's1' });
      b.addSample({ frames: [FRAME_RUN], timestampNs: 200, traceId: 'abc', spanId: 's1' });
      const p = b.serialize() as unknown as InnerProfile;
      expect(p.link_table.length).toBe(2); // sentinel + 1
      expect(p.link_table[1]).toEqual({ trace_id: 'abc', span_id: 's1' });
    });

    it('empty trace_id treated as no link', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 100, traceId: '', operation: 'GET /a' });
      const p = b.serialize() as unknown as InnerProfile;
      expect(p.link_table.length).toBe(1); // sentinel only
      expect(p.samples[0].link_index).toBeUndefined();
    });

    it('omits link_index when 0 (sentinel)', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 100, operation: 'GET /a' });
      const p = b.serialize() as unknown as InnerProfile;
      expect(p.samples[0].link_index).toBeUndefined();
    });
  });

  describe('Attribute table', function () {
    it('thread.name and operation indexed', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 100, threadName: 'worker-1', operation: 'GET /a' });
      const p = b.serialize() as unknown as InnerProfile;
      expect(p.attribute_table.length).toBe(3); // sentinel + thread.name + operation
      const attrs = p.samples[0].attribute_indices!;
      const keys = attrs.map(i => p.attribute_table[i].key_strindex);
      expect(keys).toContain(3);
      expect(keys).toContain(4);
    });

    it('omits attribute_indices when empty', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 100, traceId: 'abc', spanId: 's1' });
      const p = b.serialize() as unknown as InnerProfile;
      expect(p.samples[0].attribute_indices).toBeUndefined();
    });
  });

  describe('Sample filtering (serializeCompressed)', function () {
    it('drops background-only samples', async function () {
      const b = new OtlpProfileBuilder(1000, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 1_000_000, threadName: 'background' });
      b.addSample({ frames: [FRAME_RUN, FRAME_HANDLE], timestampNs: 2_000_000, threadName: 't', operation: 'GET /a' });
      b.addSample({
        frames: [FRAME_RUN, FRAME_QUERY],
        timestampNs: 3_000_000,
        threadName: 't',
        traceId: 'abc',
        spanId: 's1',
      });

      const wrapper = await b.serializeCompressed();
      const inner = await decompressWrapper(wrapper);
      expect(inner.samples.length).toBe(2);
    });

    it('getFilteredSampleCount matches what serializeCompressed emits', async function () {
      const b = new OtlpProfileBuilder(1000, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 1_000_000, threadName: 'bg' }); // dropped
      b.addSample({ frames: [FRAME_RUN], timestampNs: 2_000_000, threadName: 't', operation: 'GET /a' }); // kept
      expect(b.getFilteredSampleCount()).toBe(1);
      expect(b.getSampleCount()).toBe(2);
      const wrapper = await b.serializeCompressed();
      const inner = await decompressWrapper(wrapper);
      expect(inner.samples.length).toBe(1);
    });

    it('uncompressed serialize keeps all samples', function () {
      const b = new OtlpProfileBuilder(1000, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 1_000_000, threadName: 'bg' });
      b.addSample({ frames: [FRAME_RUN], timestampNs: 2_000_000, threadName: 't', operation: 'GET /a' });
      const p = b.serialize() as unknown as InnerProfile;
      expect(p.samples.length).toBe(2);
    });
  });

  describe('time_offset_ms', function () {
    it('compressed uses offset; uncompressed uses absolute ns', async function () {
      const timeUnix = 1_000_000_000_000;
      const b = new OtlpProfileBuilder(timeUnix, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: timeUnix + 5_230_000_000, threadName: 't', operation: 'GET /a' });

      const wrapper = await b.serializeCompressed();
      const inner = await decompressWrapper(wrapper);
      expect(inner.samples[0].time_offset_ms).toBe(5230);
      expect(inner.samples[0].timestamps_unix_nano).toBeUndefined();

      const raw = b.serialize() as unknown as InnerProfile;
      expect(raw.samples[0].timestamps_unix_nano).toBe(timeUnix + 5_230_000_000);
      expect(raw.samples[0].time_offset_ms).toBeUndefined();
    });
  });

  describe('Compressed wrapper', function () {
    it('shape: encoding/data/trace_links/operations', async function () {
      const b = new OtlpProfileBuilder(1000, 60_000_000_000, 10_000_000);
      b.addSample({
        frames: [FRAME_RUN, FRAME_HANDLE],
        timestampNs: 2_000_000,
        threadName: 't1',
        operation: 'GET /api/users',
        traceId: 'aabb0011',
        spanId: '11220011',
      });
      b.addSample({
        frames: [FRAME_RUN, FRAME_QUERY],
        timestampNs: 3_000_000,
        threadName: 't2',
        operation: 'POST /api/orders',
        traceId: 'ccdd0011',
        spanId: '33440011',
      });

      const wrapper = await b.serializeCompressed();
      expect(wrapper.encoding).toBe('zstd');
      expect(typeof wrapper.data).toBe('string');
      expect(wrapper.trace_links.length).toBe(2);
      expect(wrapper.operations.length).toBe(2);
      expect(wrapper.trace_links).toContainEqual({ trace_id: 'aabb0011', span_id: '11220011' });
      expect(wrapper.operations).toContain('GET /api/users');
    });

    it('zstd round-trip yields valid inner profile', async function () {
      const b = new OtlpProfileBuilder(1000, 60_000_000_000, 10_000_000);
      b.addSample({
        frames: [FRAME_RUN, FRAME_HANDLE],
        timestampNs: 2_000_000,
        threadName: 't',
        operation: 'GET /a',
        traceId: 'abc',
        spanId: 's1',
      });

      const wrapper = await b.serializeCompressed();
      const inner = await decompressWrapper(wrapper);
      expect(inner.sample_type).toEqual({ type_strindex: 1, unit_strindex: 2 });
      expect(inner.string_table[1]).toBe('wall');
      expect(inner.samples.length).toBe(1);
    });

    it('trace_links dedup across multiple samples', async function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      for (const ts of [1_000_000, 2_000_000, 3_000_000]) {
        b.addSample({ frames: [FRAME_RUN], timestampNs: ts, threadName: 't', traceId: 'abc', spanId: 's1' });
      }
      const wrapper = await b.serializeCompressed();
      expect(wrapper.trace_links.length).toBe(1);
    });

    it('operations dedup across multiple samples', async function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      for (const ts of [1_000_000, 2_000_000, 3_000_000]) {
        b.addSample({ frames: [FRAME_RUN], timestampNs: ts, threadName: 't', operation: 'GET /a' });
      }
      const wrapper = await b.serializeCompressed();
      expect(wrapper.operations).toEqual(['GET /a']);
    });

    it('empty profile still produces valid wrapper', async function () {
      const b = new OtlpProfileBuilder(1000, 60_000_000_000, 10_000_000);
      const wrapper = await b.serializeCompressed();
      const inner = await decompressWrapper(wrapper);
      expect(wrapper.encoding).toBe('zstd');
      expect(wrapper.trace_links).toEqual([]);
      expect(wrapper.operations).toEqual([]);
      expect(inner.samples).toEqual([]);
      expect(inner.string_table[0]).toBe(''); // sentinels still present
    });
  });

  describe('Edge cases', function () {
    it('empty frames dropped silently', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [], timestampNs: 100, threadName: 't', operation: 'GET /a' });
      expect(b.getSampleCount()).toBe(0);
    });

    it('getFilteredSampleCount=0 for empty builder', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      expect(b.getFilteredSampleCount()).toBe(0);
    });

    it('getFilteredSampleCount=0 for background-only', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 100, threadName: 'bg' });
      expect(b.getFilteredSampleCount()).toBe(0);
    });

    it('trace_id without span_id stores empty span', function () {
      const b = new OtlpProfileBuilder(0, 60_000_000_000, 10_000_000);
      b.addSample({ frames: [FRAME_RUN], timestampNs: 100, threadName: 't', traceId: 'abc' });
      const p = b.serialize() as unknown as InnerProfile;
      expect(p.link_table[1]).toEqual({ trace_id: 'abc', span_id: '' });
    });
  });

  describe('Spec conformance matrix (mirrors Python suite)', function () {
    let wrapper: CompressedProfileWrapper;
    let inner: InnerProfile;

    before(async function () {
      const timeUnix = 1_780_088_343_000_000_000;
      const b = new OtlpProfileBuilder(timeUnix, 60_000_000_000, 10_000_000);
      b.addSample({
        frames: [FRAME_RUN, FRAME_HANDLE, FRAME_QUERY],
        timestampNs: timeUnix + 5_230_000_000,
        threadName: 'http-nio-8080-exec-1',
        operation: 'GET /api/users',
        traceId: 'aabb0011223344556677889900aabbcc',
        spanId: '1122334455667788',
      });
      b.addSample({
        frames: [FRAME_RUN, FRAME_HANDLE],
        timestampNs: timeUnix + 12_500_000_000,
        threadName: 'http-nio-8080-exec-2',
        operation: 'POST /api/orders',
        traceId: 'ddee0011223344556677889900ddeeff',
        spanId: 'aabbccddeeff0011',
      });
      wrapper = await b.serializeCompressed();
      inner = await decompressWrapper(wrapper);
    });

    it('wrapper.encoding == zstd', () => expect(wrapper.encoding).toBe('zstd'));

    it('wrapper.data is base64', () => {
      expect(() => Buffer.from(wrapper.data, 'base64')).not.toThrow();
    });

    it('wrapper.trace_links well-formed', () => {
      for (const link of wrapper.trace_links) {
        expect(typeof link.trace_id).toBe('string');
        expect(typeof link.span_id).toBe('string');
        expect(link.trace_id.length).toBeGreaterThan(0);
        expect(link.span_id.length).toBeGreaterThan(0);
      }
    });

    it('wrapper.operations contain both', () => {
      expect(wrapper.operations).toContain('GET /api/users');
      expect(wrapper.operations).toContain('POST /api/orders');
    });

    it('inner sample_type', () => expect(inner.sample_type).toEqual({ type_strindex: 1, unit_strindex: 2 }));
    it('inner period_type', () => expect(inner.period_type).toEqual({ type_strindex: 1, unit_strindex: 2 }));
    it('inner time_unix_nano', () => expect(inner.time_unix_nano).toBe(1_780_088_343_000_000_000));
    it('inner duration_nano', () => expect(inner.duration_nano).toBe(60_000_000_000));
    it('inner period', () => expect(inner.period).toBe(10_000_000));
    it('inner profile_id is 32-char hex', () => {
      expect(inner.profile_id.length).toBe(32);
      expect(inner.profile_id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('inner well-known strings', () => {
      expect(inner.string_table[0]).toBe('');
      expect(inner.string_table[1]).toBe('wall');
      expect(inner.string_table[2]).toBe('nanoseconds');
      expect(inner.string_table[3]).toBe('thread.name');
      expect(inner.string_table[4]).toBe('operation');
    });

    it('inner sentinels in all 6 dictionary tables', () => {
      expect(inner.function_table[0]).toEqual({
        name_strindex: 0,
        system_name_strindex: 0,
        filename_strindex: 0,
        start_line: 0,
      });
      expect(inner.location_table[0].lines).toEqual([{ function_index: 0, line: 0 }]);
      expect(inner.stack_table[0].location_indices).toEqual([0]);
      expect(inner.link_table[0]).toEqual({ trace_id: '', span_id: '' });
      expect(inner.attribute_table[0]).toEqual({ key_strindex: 0, value_strindex: 0 });
    });

    it('inner sample shape (every sample has stack_index, time_offset_ms, link_index, attribute_indices)', () => {
      for (const sample of inner.samples) {
        expect(sample.stack_index).toBeGreaterThan(0);
        expect(sample.time_offset_ms).toBeGreaterThanOrEqual(0);
        expect(sample.time_offset_ms!).toBeLessThan(60_000);
        expect(sample.link_index).toBeGreaterThan(0);
        expect(sample.attribute_indices!.length).toBeGreaterThan(0);
      }
    });

    it('inner attribute_indices resolve to thread.name and operation', () => {
      for (const sample of inner.samples) {
        const keys = sample.attribute_indices!.map(i => inner.attribute_table[i].key_strindex);
        expect(keys).toContain(3); // thread.name
        expect(keys).toContain(4); // operation
      }
    });

    it('inner link_index resolves to non-empty trace in link_table', () => {
      for (const sample of inner.samples) {
        const link = inner.link_table[sample.link_index!];
        expect(link.trace_id.length).toBeGreaterThan(0);
        expect(link.span_id.length).toBeGreaterThan(0);
      }
    });

    it('only filtered samples present (both have link + operation)', () => {
      expect(inner.samples.length).toBe(2);
    });
  });
});
