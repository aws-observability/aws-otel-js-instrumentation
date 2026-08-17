// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { defaultSampler, resolveEnvSampler, resolveEnvSamplerOrDefault } from '../src/internal/env-sampler';

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
