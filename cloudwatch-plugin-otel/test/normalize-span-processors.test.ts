// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import { normalizeSpanProcessors, NormalizeConfig } from '../src/internal/normalize-span-processors';

// Sentinels standing in for real processors/exporters — the normalizer only moves references around.
const OURS = { id: 'span-metrics' };
const wrapped = (e: unknown) => ({ id: 'batch', exporter: e });
const ENV = [{ id: 'env-batch' }];

function deps() {
  return {
    makeSpanMetricsProcessor: () => OURS,
    wrapExporter: wrapped,
    envSpanProcessors: () => [...ENV],
  };
}

describe('normalizeSpanProcessors (register CONFIG layout)', () => {
  it('appends ours to an explicit spanProcessors list', () => {
    const existing = { id: 'user-sp' };
    const cfg: NormalizeConfig = { spanProcessors: [existing] };
    const out = normalizeSpanProcessors(cfg, deps());
    assert.deepStrictEqual(out, [existing, OURS]);
    assert.strictEqual(cfg.spanProcessors, out);
  });

  it('converts a deprecated singular spanProcessor and removes it', () => {
    const sp = { id: 'user-single' };
    const cfg: NormalizeConfig = { spanProcessor: sp };
    const out = normalizeSpanProcessors(cfg, deps());
    assert.deepStrictEqual(out, [sp, OURS]);
    assert.ok(!('spanProcessor' in cfg), 'singular spanProcessor removed so NodeSDK does not double-count');
  });

  it('B3: preserves a lone traceExporter by wrapping it, and removes traceExporter', () => {
    const exporter = { id: 'user-exporter' };
    const cfg: NormalizeConfig = { traceExporter: exporter };
    const out = normalizeSpanProcessors(cfg, deps());
    // The exporter survives as a batch processor, and ours is appended.
    assert.deepStrictEqual(out, [wrapped(exporter), OURS]);
    // Critical: traceExporter is removed so setting spanProcessors doesn't make NodeSDK ignore it.
    assert.ok(!('traceExporter' in cfg), 'traceExporter removed to avoid NodeSDK dropping it');
  });

  it('falls back to env processors when nothing is configured (pure zero-code)', () => {
    const cfg: NormalizeConfig = {};
    const out = normalizeSpanProcessors(cfg, deps());
    assert.deepStrictEqual(out, [...ENV, OURS]);
  });

  it('does not mutate the original spanProcessors array in place', () => {
    const arr = [{ id: 'a' }];
    const cfg: NormalizeConfig = { spanProcessors: arr };
    normalizeSpanProcessors(cfg, deps());
    assert.strictEqual(arr.length, 1, 'caller array is copied, not appended to');
  });
});
