// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { getNumberFromEnv, getStringFromEnv } from '@opentelemetry/core';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  Sampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';

/*
 * Why this file exists (deliberately a small, self-contained copy of OpenTelemetry behavior):
 *
 * This extension must WRAP the user's configured sampler in a record-forcing sampler BEFORE the SDK
 * builds its TracerProvider — a wrapper applied afterward is not honored, because tracers capture
 * their sampler at creation time (verified). When sampling is configured via the environment
 * (OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG) rather than an explicit `sampler` object, we
 * therefore have to resolve that env sampler ourselves so we have something concrete to wrap.
 *
 * We considered and rejected two alternatives:
 *   1. Importing the SDK's own resolver — it lives at different non-public `build/src/*` paths in
 *      different sdk-node/sdk-trace-base versions, and this helper is also used by the public
 *      `withSpanMetrics` API, where reaching into SDK internals would be brittle and would tie
 *      consumers to specific OTel versions.
 *   2. Wrapping the sampler the SDK already built — not viable, since tracers capture the sampler at
 *      creation and post-construction replacement races with instrumentation that creates tracers
 *      during SDK start.
 *
 * So we mirror the OpenTelemetry env-sampler mapping using only PUBLIC sampler classes and core's
 * public env parsers (getStringFromEnv/getNumberFromEnv — identical numeric parsing to the SDK). The
 * mapping and the DEFAULT_RATIO/out-of-range fallback below are frozen by the OTel specification, so
 * drift risk is low; the nightly latest-version CI would surface any divergence.
 *
 * CRITICAL (this is the bug this file fixes): a blank, non-numeric, negative, or >1 ARG must fall
 * back to ratio 1 (record everything) exactly as the SDK does — NEVER to ratio 0, which would
 * silently drop all trace export while our 100% metrics masked the failure.
 */

const DEFAULT_RATIO = 1;

function ratioFromEnv(): number {
  const ratio = getNumberFromEnv('OTEL_TRACES_SAMPLER_ARG');
  if (ratio == null) {
    diag.warn(`[span-metrics] OTEL_TRACES_SAMPLER_ARG is blank or invalid; defaulting to ${DEFAULT_RATIO}.`);
    return DEFAULT_RATIO;
  }
  if (ratio < 0 || ratio > 1) {
    diag.warn(
      `[span-metrics] OTEL_TRACES_SAMPLER_ARG=${ratio} is out of range [0..1]; defaulting to ${DEFAULT_RATIO}.`
    );
    return DEFAULT_RATIO;
  }
  return ratio;
}

// The sampler the SDK applies when OTEL_TRACES_SAMPLER is unset or unrecognized. Single source of
// truth so callers don't each hard-code it; kept equal to the SDK default (verified: ParentBased
// (AlwaysOn) in every supported sdk-node version, for both the unset and unknown-name cases).
export function defaultSampler(): Sampler {
  return new ParentBasedSampler({ root: new AlwaysOnSampler() });
}

/**
 * Resolves the sampler the SDK would build from OTEL_TRACES_SAMPLER(+_ARG), using public sampler
 * classes. Returns undefined when OTEL_TRACES_SAMPLER is unset or unrecognized — callers that must
 * always wrap a sampler should use {@link resolveEnvSamplerOrDefault} instead.
 */
export function resolveEnvSampler(): Sampler | undefined {
  const name = getStringFromEnv('OTEL_TRACES_SAMPLER');
  if (name === undefined) {
    return undefined;
  }
  switch (name) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratioFromEnv());
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratioFromEnv()) });
    default:
      diag.warn(`[span-metrics] unknown OTEL_TRACES_SAMPLER value "${name}"; using the SDK default sampler.`);
      return undefined;
  }
}

/**
 * Like {@link resolveEnvSampler} but never returns undefined: falls back to {@link defaultSampler}
 * when no env sampler is configured or the value is unrecognized. Used everywhere the extension must
 * force-record a concrete sampler (both zero-code and withSpanMetrics), so the two modes behave
 * identically and the default lives in one place.
 */
export function resolveEnvSamplerOrDefault(): Sampler {
  return resolveEnvSampler() ?? defaultSampler();
}
