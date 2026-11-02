// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import {
  defaultSampler,
  envNumber,
  envString,
  resolveEnvSampler,
  resolveEnvSamplerOrDefault,
} from '../src/internal/env-sampler';

// Sets an arbitrary env var (or unsets it when value is undefined), runs fn, and restores.
function withVar(name: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// Sets OTEL_TRACES_SAMPLER(+_ARG) the way a user would, resolves, and restores env afterward.
function withEnv(sampler: string | undefined, arg: string | undefined, fn: () => void): void {
  const prevName = process.env.OTEL_TRACES_SAMPLER;
  const prevArg = process.env.OTEL_TRACES_SAMPLER_ARG;
  if (sampler === undefined) delete process.env.OTEL_TRACES_SAMPLER;
  else process.env.OTEL_TRACES_SAMPLER = sampler;
  if (arg === undefined) delete process.env.OTEL_TRACES_SAMPLER_ARG;
  else process.env.OTEL_TRACES_SAMPLER_ARG = arg;
  try {
    fn();
  } finally {
    if (prevName === undefined) delete process.env.OTEL_TRACES_SAMPLER;
    else process.env.OTEL_TRACES_SAMPLER = prevName;
    if (prevArg === undefined) delete process.env.OTEL_TRACES_SAMPLER_ARG;
    else process.env.OTEL_TRACES_SAMPLER_ARG = prevArg;
  }
}

// Pull the effective ratio out of a (possibly ParentBased-wrapped) TraceIdRatioBasedSampler by
// parsing its description, e.g. "ParentBased{root=TraceIdRatioBased{0.25}, ...}".
function ratioOf(sampler: { toString(): string }): number {
  const m = /TraceIdRatioBased\{([0-9.]+)/.exec(sampler.toString());
  assert.ok(m, `expected a TraceIdRatioBased sampler, got: ${sampler.toString()}`);
  return Number(m![1]);
}

describe('resolveEnvSampler', () => {
  it('returns undefined when OTEL_TRACES_SAMPLER is unset (SDK default applies)', () => {
    withEnv(undefined, undefined, () => {
      assert.strictEqual(resolveEnvSampler(), undefined);
    });
  });

  it('maps the named samplers to the right classes', () => {
    withEnv('always_on', undefined, () => assert.ok(resolveEnvSampler() instanceof AlwaysOnSampler));
    withEnv('always_off', undefined, () => assert.ok(resolveEnvSampler() instanceof AlwaysOffSampler));
    withEnv('parentbased_always_on', undefined, () => assert.ok(resolveEnvSampler() instanceof ParentBasedSampler));
    withEnv('parentbased_always_off', undefined, () => assert.ok(resolveEnvSampler() instanceof ParentBasedSampler));
    withEnv('traceidratio', '0.25', () => {
      const s = resolveEnvSampler()!;
      assert.ok(s instanceof TraceIdRatioBasedSampler);
      assert.strictEqual(ratioOf(s), 0.25);
    });
    withEnv('parentbased_traceidratio', '0.25', () => {
      const s = resolveEnvSampler()!;
      assert.ok(s instanceof ParentBasedSampler);
      assert.strictEqual(ratioOf(s), 0.25);
    });
  });

  it('returns undefined for an unrecognized sampler name (does NOT force a sampler)', () => {
    withEnv('some_future_sampler', undefined, () => {
      assert.strictEqual(resolveEnvSampler(), undefined);
    });
  });

  // The core of B5: a malformed/out-of-range ARG must default to ratio 1 (record everything),
  // NEVER ratio 0 (which would silently drop all trace export).
  it('defaults ratio to 1 for a non-numeric ARG (abc)', () => {
    withEnv('traceidratio', 'abc', () => assert.strictEqual(ratioOf(resolveEnvSampler()!), 1));
  });

  it('defaults ratio to 1 for a blank ARG', () => {
    withEnv('traceidratio', '', () => assert.strictEqual(ratioOf(resolveEnvSampler()!), 1));
  });

  it('defaults ratio to 1 for a whitespace ARG', () => {
    withEnv('traceidratio', '   ', () => assert.strictEqual(ratioOf(resolveEnvSampler()!), 1));
  });

  it('defaults ratio to 1 for a negative ARG', () => {
    withEnv('traceidratio', '-1', () => assert.strictEqual(ratioOf(resolveEnvSampler()!), 1));
  });

  it('defaults ratio to 1 for an ARG greater than 1', () => {
    withEnv('traceidratio', '2', () => assert.strictEqual(ratioOf(resolveEnvSampler()!), 1));
  });

  it('honors a valid in-range ARG (0 is respected, not defaulted)', () => {
    withEnv('traceidratio', '0', () => assert.strictEqual(ratioOf(resolveEnvSampler()!), 0));
  });
});

describe('resolveEnvSamplerOrDefault', () => {
  it('falls back to the SDK default (ParentBased(AlwaysOn)) when unset', () => {
    withEnv(undefined, undefined, () => {
      const s = resolveEnvSamplerOrDefault();
      assert.ok(s instanceof ParentBasedSampler);
      assert.strictEqual(s.toString(), defaultSampler().toString());
    });
  });

  it('falls back to the SDK default for an unrecognized sampler name', () => {
    withEnv('some_future_sampler', undefined, () => {
      assert.strictEqual(resolveEnvSamplerOrDefault().toString(), defaultSampler().toString());
    });
  });

  it('returns the configured env sampler when one is set', () => {
    withEnv('always_off', undefined, () => assert.ok(resolveEnvSamplerOrDefault() instanceof AlwaysOffSampler));
  });
});

// These parsers are inlined (not imported from @opentelemetry/core, which is not a declared
// dependency). Pin their behavior to core's getStringFromEnv/getNumberFromEnv contract so the
// inlined copies cannot silently drift.
describe('envString (inlined getStringFromEnv equivalent)', () => {
  const VAR = 'SPAN_METRICS_TEST_STR';

  it('returns undefined when unset', () => {
    withVar(VAR, undefined, () => assert.strictEqual(envString(VAR), undefined));
  });

  it('treats an empty string as unset', () => {
    withVar(VAR, '', () => assert.strictEqual(envString(VAR), undefined));
  });

  it('treats a whitespace-only string as unset', () => {
    withVar(VAR, '   ', () => assert.strictEqual(envString(VAR), undefined));
  });

  it('returns a non-empty value verbatim (not trimmed)', () => {
    withVar(VAR, 'abc', () => assert.strictEqual(envString(VAR), 'abc'));
    withVar(VAR, ' x ', () => assert.strictEqual(envString(VAR), ' x '));
  });
});

describe('envNumber (inlined getNumberFromEnv equivalent)', () => {
  const VAR = 'SPAN_METRICS_TEST_NUM';

  it('returns undefined when unset, blank, or whitespace', () => {
    withVar(VAR, undefined, () => assert.strictEqual(envNumber(VAR), undefined));
    withVar(VAR, '', () => assert.strictEqual(envNumber(VAR), undefined));
    withVar(VAR, '   ', () => assert.strictEqual(envNumber(VAR), undefined));
  });

  it('returns undefined for a non-numeric value (NaN -> undefined)', () => {
    withVar(VAR, 'abc', () => assert.strictEqual(envNumber(VAR), undefined));
  });

  it('parses valid numbers, including 0, negatives, >1, and scientific notation', () => {
    withVar(VAR, '0', () => assert.strictEqual(envNumber(VAR), 0));
    withVar(VAR, '0.5', () => assert.strictEqual(envNumber(VAR), 0.5));
    withVar(VAR, '-1', () => assert.strictEqual(envNumber(VAR), -1));
    withVar(VAR, '2', () => assert.strictEqual(envNumber(VAR), 2));
    withVar(VAR, ' 3 ', () => assert.strictEqual(envNumber(VAR), 3));
    withVar(VAR, '1e2', () => assert.strictEqual(envNumber(VAR), 100));
  });
});
