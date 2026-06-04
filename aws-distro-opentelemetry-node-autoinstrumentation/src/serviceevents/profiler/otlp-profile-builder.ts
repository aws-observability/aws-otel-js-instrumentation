// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OTLP profile builder with dictionary-based deduplication.
 *
 * Each sample is added individually via {@link addSample}. Structural data
 * (strings, functions, locations, stacks, links, attributes) is deduplicated
 * into shared tables.
 *
 * Threading: Node is single-threaded. The collector calls add* methods from
 * the rotation timer's tick — no synchronization needed.
 *
 * Mirrors Python {@code OtlpProfileBuilder}.
 */

import { randomUUID } from 'crypto';

// Spec §8 well-known string indices. Index 0 is reserved as the empty-string
// sentinel for all dictionary tables.
const _STR_EMPTY = 0;
const _STR_WALL = 1;
const _STR_NANOSECONDS = 2;
const _STR_THREAD_NAME = 3;
const _STR_OPERATION = 4;

const _ZSTD_LEVEL = 10;

/** Structured frame info — one stack frame, ready for interning. */
export interface FrameInfo {
  methodName: string;
  qualifiedName: string;
  fileName: string;
  lineNumber: number;
  /** Function declaration line (function_table.start_line). pprof's startLine. */
  startLine: number;
}

interface FunctionRow {
  name_strindex: number;
  system_name_strindex: number;
  filename_strindex: number;
  start_line: number;
}

interface LocationRow {
  function_index: number;
  line: number;
}

interface LinkRow {
  trace_id: string;
  span_id: string;
}

interface AttributeRow {
  key_strindex: number;
  value_strindex: number;
}

interface SampleOut {
  stack_index: number;
  /** Present in serialize() only; replaced by time_offset_ms in serializeCompressed(). */
  timestamps_unix_nano?: number;
  /** Present in serializeCompressed() only. */
  time_offset_ms?: number;
  link_index?: number;
  attribute_indices?: number[];
}

/** Compressed wrapper produced by serializeCompressed(). */
export interface CompressedProfileWrapper {
  encoding: 'zstd';
  data: string;
  trace_links: Array<{ trace_id: string; span_id: string }>;
  operations: string[];
}

/** Lazy zstd codec init: zstd-codec is async (callback-based), wrap once. */
let _zstdSimplePromise: Promise<{ compress(input: Uint8Array | Buffer, level: number): Uint8Array }> | null = null;
function _getZstdSimple(): Promise<{ compress(input: Uint8Array | Buffer, level: number): Uint8Array }> {
  if (_zstdSimplePromise) return _zstdSimplePromise;
  _zstdSimplePromise = new Promise((resolve, reject) => {
    try {
      // Lazy require so missing optional dep surfaces only when serializeCompressed runs.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ZstdCodec } = require('zstd-codec');
      ZstdCodec.run((zstd: { Simple: new () => { compress(b: Uint8Array | Buffer, l: number): Uint8Array } }) => {
        try {
          resolve(new zstd.Simple());
        } catch (err) {
          reject(err);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
  return _zstdSimplePromise;
}

/** For tests: drop the cached zstd codec so each test sees a fresh init. */
export function __resetZstdCodecForTests(): void {
  _zstdSimplePromise = null;
}

export class OtlpProfileBuilder {
  private readonly _timeUnixNano: number;
  private readonly _durationNano: number;
  private readonly _periodNano: number;
  private readonly _profileId: string;

  // Dictionary tables. Index 0 in each is the sentinel/zero entry.
  private readonly _stringTable: string[] = [];
  private readonly _stringIndex: Map<string, number> = new Map();

  private readonly _functionTable: FunctionRow[] = [];
  private readonly _functionIndex: Map<string, number> = new Map();

  private readonly _locationTable: LocationRow[] = [];
  private readonly _locationIndex: Map<string, number> = new Map();

  private readonly _stackTable: number[][] = [];
  private readonly _stackIndex: Map<string, number> = new Map();

  private readonly _linkTable: LinkRow[] = [];
  private readonly _linkIndex: Map<string, number> = new Map();

  private readonly _attributeTable: AttributeRow[] = [];
  private readonly _attributeIndex: Map<number, number> = new Map();

  // Sample storage. Time stays in absolute ns internally; converted to
  // time_offset_ms only at serialize-compressed time, where filtering happens.
  private readonly _sampleStack: number[] = [];
  private readonly _sampleTimestampNs: number[] = [];
  private readonly _sampleLink: number[] = [];
  private readonly _sampleAttrs: (number[] | null)[] = [];

  constructor(timeUnixNano: number, durationNano: number, periodNano: number) {
    this._timeUnixNano = timeUnixNano;
    this._durationNano = durationNano;
    this._periodNano = periodNano;
    this._profileId = randomUUID().replace(/-/g, '');

    // Pre-register sentinels and well-known strings.
    this._internString(''); // _STR_EMPTY
    if (this._internString('wall') !== _STR_WALL) throw new Error('well-known index drift: wall');
    if (this._internString('nanoseconds') !== _STR_NANOSECONDS) throw new Error('well-known index drift: nanoseconds');
    if (this._internString('thread.name') !== _STR_THREAD_NAME) throw new Error('well-known index drift: thread.name');
    if (this._internString('operation') !== _STR_OPERATION) throw new Error('well-known index drift: operation');

    this._functionTable.push({ name_strindex: 0, system_name_strindex: 0, filename_strindex: 0, start_line: 0 });
    this._functionIndex.set('0|0|0|0', 0);

    this._locationTable.push({ function_index: 0, line: 0 });
    this._locationIndex.set('0|0', 0);

    this._stackTable.push([0]);
    this._stackIndex.set('0', 0);

    this._linkTable.push({ trace_id: '', span_id: '' });
    this._linkIndex.set(':', 0);

    this._attributeTable.push({ key_strindex: 0, value_strindex: 0 });
    this._attributeIndex.set(0, 0);
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Record a single sample. Frames must be in root → leaf order. Empty frame
   * lists are silently dropped.
   */
  addSample(opts: {
    frames: FrameInfo[];
    timestampNs: number;
    threadName?: string | null;
    operation?: string | null;
    traceId?: string | null;
    spanId?: string | null;
  }): void {
    if (!opts.frames || opts.frames.length === 0) return;

    const stackIdx = this._internStack(opts.frames);
    const linkIdx = opts.traceId ? this._internLink(opts.traceId, opts.spanId ?? '') : 0;

    const attrIndices: number[] = [];
    if (opts.threadName) {
      attrIndices.push(this._internAttribute(_STR_THREAD_NAME, this._internString(opts.threadName)));
    }
    if (opts.operation) {
      attrIndices.push(this._internAttribute(_STR_OPERATION, this._internString(opts.operation)));
    }

    this._sampleStack.push(stackIdx);
    this._sampleTimestampNs.push(opts.timestampNs);
    this._sampleLink.push(linkIdx);
    this._sampleAttrs.push(attrIndices.length > 0 ? attrIndices : null);
  }

  getSampleCount(): number {
    return this._sampleStack.length;
  }

  getUniqueStackCount(): number {
    return this._stackTable.length;
  }

  /**
   * Count of samples that would survive serialize-time filtering (link OR operation attr).
   * Useful for callers deciding whether to skip emission entirely.
   */
  getFilteredSampleCount(): number {
    let count = 0;
    for (let i = 0; i < this._sampleStack.length; i++) {
      if (this._sampleLink[i] !== 0 || this._sampleHasOperation(i)) count++;
    }
    return count;
  }

  /** Return the full uncompressed profile dict (all samples, no filter). */
  serialize(): Record<string, unknown> {
    return this._buildProfile(false);
  }

  /**
   * Return the spec §8 compressed wrapper. Async because zstd-codec init is
   * callback-based.
   */
  async serializeCompressed(): Promise<CompressedProfileWrapper> {
    const profile = this._buildProfile(true);
    const samples = profile.samples as SampleOut[];

    const json = Buffer.from(JSON.stringify(profile), 'utf8');
    const zstd = await _getZstdSimple();
    const compressed = zstd.compress(json, _ZSTD_LEVEL);
    const data = Buffer.from(compressed).toString('base64');

    // Surface unique trace_links and operations from the filtered sample set.
    const seenLinks = new Set<string>();
    const traceLinks: Array<{ trace_id: string; span_id: string }> = [];
    const seenOps = new Set<string>();
    const operations: string[] = [];

    for (const sample of samples) {
      const linkIdx = sample.link_index ?? 0;
      if (linkIdx) {
        const entry = this._linkTable[linkIdx];
        const key = `${entry.trace_id}:${entry.span_id}`;
        if (!seenLinks.has(key)) {
          seenLinks.add(key);
          traceLinks.push({ trace_id: entry.trace_id, span_id: entry.span_id });
        }
      }
      for (const attrIdx of sample.attribute_indices ?? []) {
        const attr = this._attributeTable[attrIdx];
        if (attr.key_strindex === _STR_OPERATION) {
          const op = this._stringTable[attr.value_strindex];
          if (!seenOps.has(op)) {
            seenOps.add(op);
            operations.push(op);
          }
        }
      }
    }

    return { encoding: 'zstd', data, trace_links: traceLinks, operations };
  }

  // ─── Profile assembly ──────────────────────────────────────────────

  private _buildProfile(filterSamples: boolean): Record<string, unknown> {
    const samples: SampleOut[] = [];
    for (let i = 0; i < this._sampleStack.length; i++) {
      const linkIdx = this._sampleLink[i];
      const attrs = this._sampleAttrs[i];
      if (filterSamples && linkIdx === 0 && !this._sampleHasOperation(i)) continue;

      const out: SampleOut = { stack_index: this._sampleStack[i] };
      if (filterSamples) {
        out.time_offset_ms = Math.floor((this._sampleTimestampNs[i] - this._timeUnixNano) / 1_000_000);
      } else {
        out.timestamps_unix_nano = this._sampleTimestampNs[i];
      }
      if (linkIdx !== 0) out.link_index = linkIdx;
      if (attrs) out.attribute_indices = [...attrs];
      samples.push(out);
    }

    return {
      sample_type: { type_strindex: _STR_WALL, unit_strindex: _STR_NANOSECONDS },
      time_unix_nano: this._timeUnixNano,
      duration_nano: this._durationNano,
      period_type: { type_strindex: _STR_WALL, unit_strindex: _STR_NANOSECONDS },
      period: this._periodNano,
      profile_id: this._profileId,
      string_table: [...this._stringTable],
      function_table: this._functionTable.map(f => ({ ...f })),
      location_table: this._locationTable.map(loc => ({
        lines: [{ function_index: loc.function_index, line: loc.line }],
      })),
      stack_table: this._stackTable.map(s => ({ location_indices: [...s] })),
      link_table: this._linkTable.map(link => ({ ...link })),
      attribute_table: this._attributeTable.map(a => ({ ...a })),
      samples,
    };
  }

  private _sampleHasOperation(i: number): boolean {
    const attrs = this._sampleAttrs[i];
    if (!attrs) return false;
    for (const attrIdx of attrs) {
      if (this._attributeTable[attrIdx].key_strindex === _STR_OPERATION) return true;
    }
    return false;
  }

  // ─── Interning ─────────────────────────────────────────────────────

  private _internString(s: string | null | undefined): number {
    if (s === null || s === undefined) return _STR_EMPTY;
    const cached = this._stringIndex.get(s);
    if (cached !== undefined) return cached;
    const idx = this._stringTable.length;
    this._stringTable.push(s);
    this._stringIndex.set(s, idx);
    return idx;
  }

  private _internFunction(frame: FrameInfo): number {
    const nameIdx = this._internString(frame.methodName);
    const sysNameIdx = this._internString(frame.qualifiedName);
    const fileIdx = this._internString(frame.fileName);
    const key = `${nameIdx}|${sysNameIdx}|${fileIdx}|${frame.startLine}`;
    const cached = this._functionIndex.get(key);
    if (cached !== undefined) return cached;
    const idx = this._functionTable.length;
    this._functionTable.push({
      name_strindex: nameIdx,
      system_name_strindex: sysNameIdx,
      filename_strindex: fileIdx,
      start_line: frame.startLine,
    });
    this._functionIndex.set(key, idx);
    return idx;
  }

  private _internLocation(frame: FrameInfo): number {
    const funcIdx = this._internFunction(frame);
    const key = `${funcIdx}|${frame.lineNumber}`;
    const cached = this._locationIndex.get(key);
    if (cached !== undefined) return cached;
    const idx = this._locationTable.length;
    this._locationTable.push({ function_index: funcIdx, line: frame.lineNumber });
    this._locationIndex.set(key, idx);
    return idx;
  }

  private _internStack(frames: FrameInfo[]): number {
    const locIndices = frames.map(f => this._internLocation(f));
    const key = locIndices.join(',');
    const cached = this._stackIndex.get(key);
    if (cached !== undefined) return cached;
    const idx = this._stackTable.length;
    this._stackTable.push(locIndices);
    this._stackIndex.set(key, idx);
    return idx;
  }

  private _internLink(traceId: string, spanId: string): number {
    if (!traceId) return 0;
    const span = spanId ?? '';
    const key = `${traceId}:${span}`;
    const cached = this._linkIndex.get(key);
    if (cached !== undefined) return cached;
    const idx = this._linkTable.length;
    this._linkTable.push({ trace_id: traceId, span_id: span });
    this._linkIndex.set(key, idx);
    return idx;
  }

  private _internAttribute(keyStrindex: number, valueStrindex: number): number {
    // Pack the (key, value) pair into a single number key. JS numbers are 53-bit;
    // string indices won't exceed 2^26 in any realistic profile.
    const key = keyStrindex * 2 ** 26 + valueStrindex;
    const cached = this._attributeIndex.get(key);
    if (cached !== undefined) return cached;
    const idx = this._attributeTable.length;
    this._attributeTable.push({ key_strindex: keyStrindex, value_strindex: valueStrindex });
    this._attributeIndex.set(key, idx);
    return idx;
  }
}
