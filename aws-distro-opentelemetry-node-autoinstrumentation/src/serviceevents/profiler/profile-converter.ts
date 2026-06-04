// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Convert a pprof SerializedProfile into ServiceEvents sample records.
 *
 * pprof returns a perftools.profiles.Profile protobuf with sample/location/
 * function/stringTable arrays. We walk each Sample, dereference its locationId
 * chain into frame strings (root→leaf, reversing pprof's leaf→root order),
 * and extract the `seq` label we stamped via setProfilerSeq.
 */

import type { SerializedProfile } from './wall-profiler';
import type { RingSample } from './sample-ring';

/** One converted sample: frames root→leaf + optional request seq. */
export interface ConvertedSample {
  frames: string[];
  /** Timestamp in nanoseconds (best-effort; derived from profile endTime if available). */
  timestampNs: number;
  /** Request seq label, or undefined if the sample was taken outside any request. */
  seq?: number;
}

/**
 * Walk the Profile proto and produce a flat list of samples.
 * Returns an empty array on malformed / empty input — no throws.
 *
 * Note: @datadog/pprof returns a pprof-format `Profile` instance where
 * `stringTable` is a `StringTable` class with a `.strings` array, not a raw
 * array. Numeric fields (id, functionId, key, str, num, line) may be `number`
 * OR `bigint`. We handle both.
 */
export function convertProfile(profile: SerializedProfile | null | undefined): ConvertedSample[] {
  if (!profile || !profile.sample || !profile.location || !profile.function || !profile.stringTable) {
    return [];
  }

  // Normalize stringTable — @datadog/pprof returns a StringTable class with a
  // `.strings` array; our unit-test fixture uses a plain string[]. Handle both.
  const stringTable: string[] = Array.isArray(profile.stringTable)
    ? (profile.stringTable as string[])
    : (profile.stringTable as { strings?: string[] }).strings ?? [];

  // Build id → Location and id → Function lookup tables. pprof ids start at 1.
  const locations = new Map<number, (typeof profile.location)[number]>();
  for (const loc of profile.location) {
    const locId = _num(loc?.id);
    if (locId !== undefined) locations.set(locId, loc);
  }
  const functions = new Map<number, (typeof profile.function)[number]>();
  for (const fn of profile.function) {
    const fnId = _num(fn?.id);
    if (fnId !== undefined) functions.set(fnId, fn);
  }

  const endNs = _num(profile.timeNanos) ?? Date.now() * 1_000_000;
  const out: ConvertedSample[] = [];

  for (const sample of profile.sample) {
    const locIds = sample.locationId ?? [];
    if (locIds.length === 0) continue;

    // pprof stores locationId leaf→root; reverse to get root→leaf which is
    // what ProfileTreeBuilder expects.
    const frames: string[] = [];
    for (let i = locIds.length - 1; i >= 0; i--) {
      const id = _num(locIds[i]);
      if (id === undefined) continue;
      const loc = locations.get(id);
      if (!loc || !loc.line || loc.line.length === 0) continue;
      // A single Location may carry multiple inlined Lines (leaf→caller). Emit
      // them in reverse so deepest inlined first, matching root→leaf order.
      for (let j = loc.line.length - 1; j >= 0; j--) {
        const line = loc.line[j];
        const fnId = _num(line?.functionId);
        const fn = fnId !== undefined ? functions.get(fnId) : undefined;
        const fname = _str(stringTable, _num(fn?.name));
        const file = _str(stringTable, _num(fn?.filename));
        const lineNo = _num(line?.line) ?? _num(fn?.startLine) ?? 0;
        const frame = _formatFrame(fname, file, lineNo);
        if (frame) frames.push(frame);
      }
    }
    if (frames.length === 0) continue;

    const seq = _extractSeqLabel(sample.label, stringTable);
    out.push({ frames, timestampNs: endNs, seq });
  }

  return out;
}

function _num(v: number | bigint | undefined | null): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v;
  // bigint → number (pprof ids / line numbers fit comfortably in 2^53)
  return Number(v);
}

/**
 * Convenience: turn converted samples directly into RingSample entries
 * (used by the collector to feed the incident-enrichment buffer).
 */
export function toRingSamples(samples: ConvertedSample[]): RingSample[] {
  return samples.map(s => ({ timestampNs: s.timestampNs, frames: s.frames, seq: s.seq }));
}

function _str(table: string[], idx: number | undefined): string {
  if (idx === undefined || idx < 0 || idx >= table.length) return '';
  return table[idx] ?? '';
}

function _formatFrame(name: string, file: string, line: number): string {
  if (!name && !file) return '';
  const filename = _basename(file);
  if (filename) {
    return line ? `${name}(${filename}:${line})` : `${name}(${filename})`;
  }
  return name || '<anonymous>';
}

function _basename(path: string): string {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  const j = path.lastIndexOf('\\');
  const sep = Math.max(i, j);
  return sep >= 0 ? path.substring(sep + 1) : path;
}

type SampleLabel = NonNullable<NonNullable<SerializedProfile['sample']>[number]['label']>[number];

function _extractSeqLabel(labels: SampleLabel[] | undefined, stringTable: string[]): number | undefined {
  if (!labels) return undefined;
  for (const lbl of labels) {
    const key = _str(stringTable, _num(lbl.key));
    if (key !== 'seq') continue;
    const numVal = _num(lbl.num);
    if (numVal !== undefined && numVal !== 0) return numVal;
    const strVal = _str(stringTable, _num(lbl.str));
    if (strVal) {
      const parsed = Number(strVal);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}
