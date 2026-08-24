// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Table-driven tests for the SHARED NodeSDK trace-output resolution (one implementation, both
// wiring modes). Row numbers (R1-R6) and invariants (I2-I4) refer to the truth table in the module
// doc of src/internal/normalize-span-processors.ts and the consolidation plan:
//   R1 spanProcessors non-empty | R2 spanProcessors empty (metrics-only) | R3 singular spanProcessor
//   R4 traceExporter | R5 nothing truthy (env branch / abort) | R6 null == absent
//   I2 abort mutates nothing | I3 no danglers handed to NodeSDK | I4 exactly one warn per
//   dropped/converted input.
import * as assert from 'assert';
import { normalizeSpanProcessors, NormalizeConfig } from '../src/internal/normalize-span-processors';

// Sentinels standing in for real processors/exporters — the normalizer only moves references around.
const OURS = { id: 'span-metrics' };
const wrapped = (e: unknown) => ({ id: 'batch', exporter: e });
const ENV = [{ id: 'env-batch' }];

function deps(overrides: Partial<Parameters<typeof normalizeSpanProcessors>[1]> = {}) {
  const warnings: string[] = [];
  const d = {
    makeSpanMetricsProcessor: () => OURS,
    wrapExporter: wrapped,
    envSpanProcessors: () => [...ENV],
    warn: (message: string) => warnings.push(message),
    ...overrides,
  };
  return { d, warnings };
}

describe('normalizeSpanProcessors (shared truth-table implementation)', () => {
  // ---- R1: spanProcessors non-empty ----

  it('R1: appends ours to an explicit spanProcessors list, no warning', () => {
    const existing = { id: 'user-sp' };
    const cfg: NormalizeConfig = { spanProcessors: [existing] };
    const { d, warnings } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    assert.deepStrictEqual(out, [existing, OURS]);
    assert.strictEqual(cfg.spanProcessors, out);
    assert.strictEqual(warnings.length, 0, 'I4: nothing dropped, nothing warned');
  });

  it('R1: does not mutate the original spanProcessors array in place', () => {
    const arr = [{ id: 'a' }];
    const cfg: NormalizeConfig = { spanProcessors: arr };
    normalizeSpanProcessors(cfg, deps().d);
    assert.strictEqual(arr.length, 1, 'caller array is copied, not appended to');
  });

  it('R1+I3+I4: deletes and warns a losing singular spanProcessor', () => {
    const plural = { id: 'user-plural' };
    const singular = { id: 'user-singular' };
    const cfg: NormalizeConfig = { spanProcessors: [plural], spanProcessor: singular };
    const { d, warnings } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    assert.deepStrictEqual(out, [plural, OURS]);
    assert.ok(!('spanProcessor' in cfg), 'I3: losing singular removed');
    assert.strictEqual(warnings.length, 1, 'I4: exactly one warn for the dropped component');
    assert.ok(warnings[0].includes('IGNORED'), 'warn says the component is ignored');
  });

  it('R1+I3+I4: deletes and warns a losing traceExporter', () => {
    const plural = { id: 'user-plural' };
    const exporter = { id: 'user-exporter' };
    const cfg: NormalizeConfig = { spanProcessors: [plural], traceExporter: exporter };
    const { d, warnings } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    assert.deepStrictEqual(out, [plural, OURS]);
    assert.ok(!('traceExporter' in cfg), 'I3: losing traceExporter removed');
    assert.strictEqual(warnings.length, 1, 'I4');
  });

  it('R1+R6: cleans up a null losing field silently (it never did anything)', () => {
    const plural = { id: 'user-plural' };
    const cfg: NormalizeConfig = { spanProcessors: [plural], spanProcessor: null, traceExporter: null };
    const { d, warnings } = deps();
    normalizeSpanProcessors(cfg, d);
    assert.ok(!('spanProcessor' in cfg) && !('traceExporter' in cfg), 'I3: null losers removed');
    assert.strictEqual(warnings.length, 0, 'no warn for a null loser — no user component dropped');
  });

  // ---- R2: spanProcessors empty (metrics-without-trace-export) ----

  it('R2+I2: empty spanProcessors ABORTS untouched (trace export disabled; no provider may appear)', () => {
    // Upstream NodeSDK registers NO tracer provider for a truthy empty array — spans are
    // non-recording and no sampled trace context propagates. Wiring our processor in would create a
    // recording provider and flip downstream sampling decisions, so the extension gives itself up.
    let madeOurs = false;
    const cfg: NormalizeConfig = { spanProcessors: [] };
    const { d, warnings } = deps({
      makeSpanMetricsProcessor: () => {
        madeOurs = true;
        return OURS;
      },
    });
    const out = normalizeSpanProcessors(cfg, d);
    assert.strictEqual(out, undefined);
    assert.deepStrictEqual(cfg.spanProcessors, [], 'I2: cfg untouched — empty list stays empty');
    assert.strictEqual(madeOurs, false, 'our processor must not be constructed');
    assert.strictEqual(warnings.length, 1, 'I4');
    assert.ok(warnings[0].includes('trace export is disabled'), 'the abort must name the cause');
  });

  it('R2+I2: empty plural aborts untouched even alongside a singular and an exporter', () => {
    // The empty plural still wins NodeSDK precedence (the singular/exporter are already dead
    // upstream); the abort leaves EVERYTHING as-is — no deletes, no extra warns.
    const singular = { id: 'user-singular' };
    const exporter = { id: 'user-exporter' };
    const cfg: NormalizeConfig = { spanProcessors: [], spanProcessor: singular, traceExporter: exporter };
    const { d, warnings } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    assert.strictEqual(out, undefined);
    assert.strictEqual(cfg.spanProcessor, singular, 'I2: no deletes on the abort path');
    assert.strictEqual(cfg.traceExporter, exporter, 'I2: no deletes on the abort path');
    assert.strictEqual(warnings.length, 1, 'one abort warn only');
  });

  // ---- R3: deprecated singular spanProcessor ----

  it('R3: converts a deprecated singular spanProcessor, removes it, warns once', () => {
    const sp = { id: 'user-single' };
    const cfg: NormalizeConfig = { spanProcessor: sp };
    const { d, warnings } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    assert.deepStrictEqual(out, [sp, OURS]);
    assert.ok(!('spanProcessor' in cfg), 'I3: consumed singular removed');
    assert.strictEqual(warnings.length, 1, 'I4');
    assert.ok(warnings[0].includes('deprecated'), 'deprecation warn');
  });

  it('R3+I3+I4: singular beats traceExporter — exporter deleted and warned', () => {
    const sp = { id: 'user-single' };
    const exporter = { id: 'user-exporter' };
    const cfg: NormalizeConfig = { spanProcessor: sp, traceExporter: exporter };
    const { d, warnings } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    assert.deepStrictEqual(out, [sp, OURS]);
    assert.ok(!('traceExporter' in cfg), 'I3: losing exporter removed');
    assert.strictEqual(warnings.length, 2, 'I4: deprecation warn + dropped-exporter warn');
  });

  // ---- R4: traceExporter ----

  it('R4: preserves a lone traceExporter by wrapping it, and removes traceExporter', () => {
    const exporter = { id: 'user-exporter' };
    const cfg: NormalizeConfig = { traceExporter: exporter };
    const { d, warnings } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    // I1 (structural form): the exporter survives inside the wrapped processor, and ours is appended.
    assert.deepStrictEqual(out, [wrapped(exporter), OURS]);
    assert.ok(!('traceExporter' in cfg), 'I3: consumed exporter removed');
    assert.strictEqual(warnings.length, 0, 'I4: converted, not dropped — no warn');
  });

  it('R4: a throwing wrapper does not lose the traceExporter reference (wrap before delete)', () => {
    const exporter = { id: 'user-exporter' };
    const cfg: NormalizeConfig = { traceExporter: exporter };
    const { d } = deps({
      wrapExporter: () => {
        throw new Error('wrap boom');
      },
    });
    assert.throws(() => normalizeSpanProcessors(cfg, d));
    assert.strictEqual(cfg.traceExporter, exporter, 'exporter still on the config after a throw');
  });

  // ---- R5: nothing truthy — env branch and abort contract ----

  it('R5: falls back to env processors when nothing is configured (zero-code)', () => {
    const cfg: NormalizeConfig = {};
    const { d, warnings } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    assert.deepStrictEqual(out, [...ENV, OURS]);
    assert.strictEqual(warnings.length, 0);
  });

  it('R5+I2: an empty env-processor list (OTEL_TRACES_EXPORTER=none) aborts untouched', () => {
    // Same rule as R2: trace export disabled means upstream registers no provider; adding only our
    // processor would create one and change trace-context propagation downstream.
    const cfg: NormalizeConfig = {};
    const { d, warnings } = deps({ envSpanProcessors: () => [] });
    const out = normalizeSpanProcessors(cfg, d);
    assert.strictEqual(out, undefined);
    assert.deepStrictEqual(Object.keys(cfg), [], 'I2: cfg untouched');
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('trace export is disabled'));
  });

  it('R5+I2: aborts without touching cfg when env processors cannot be resolved', () => {
    let madeOurs = false;
    const cfg: NormalizeConfig = {};
    const { d } = deps({
      makeSpanMetricsProcessor: () => {
        madeOurs = true;
        return OURS;
      },
      envSpanProcessors: () => undefined,
    });
    const out = normalizeSpanProcessors(cfg, d);
    assert.strictEqual(out, undefined);
    assert.deepStrictEqual(Object.keys(cfg), [], 'I2: cfg completely untouched');
    assert.strictEqual(madeOurs, false, 'our processor must not be constructed on the abort path');
  });

  // ---- R6: null == absent (never a disable signal, never a crash) ----

  it('R6: null spanProcessors falls through to the next truthy field (no crash)', () => {
    const exporter = { id: 'user-exporter' };
    const cfg: NormalizeConfig = { spanProcessors: null, traceExporter: exporter };
    const { d } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    assert.deepStrictEqual(out, [wrapped(exporter), OURS]);
  });

  it('R6: all-null config behaves exactly like an empty config (env branch)', () => {
    const cfg: NormalizeConfig = { spanProcessors: null, spanProcessor: null, traceExporter: null };
    const { d } = deps();
    const out = normalizeSpanProcessors(cfg, d);
    assert.deepStrictEqual(out, [...ENV, OURS]);
  });
});
