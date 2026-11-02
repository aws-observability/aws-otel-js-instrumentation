// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Context, Link, SpanAttributes, SpanKind, diag } from '@opentelemetry/api';
import { Sampler, SamplingDecision, SamplingResult } from '@opentelemetry/sdk-trace-base';

/**
 * Wraps the configured sampler and turns NOT_RECORD (DROP) decisions into RECORD (RECORD_ONLY).
 * Spans the delegate would drop are still recorded, so {@link SpanMetricsProcessor.onEnd} sees them,
 * but they are not exported, so trace volume still honors the configured sampling rate.
 *
 * Behavior is frozen by the OpenTelemetry spec (AlwaysRecord). We define it against
 * `sdk-trace-base` — matching this repo's existing App Signals sampler and avoiding a second trace
 * SDK dependency — rather than importing `createAlwaysRecordSampler` from the `@opentelemetry/
 * sdk-trace` meta-package (the only place that helper is exported). The DROP->RECORD mapping is
 * identical either way.
 */
export class AlwaysRecordSampler implements Sampler {
  private readonly rootSampler: Sampler;

  static create(rootSampler: Sampler): AlwaysRecordSampler {
    diag.info(
      `Span metrics: sampler wrapped (${rootSampler.toString()}); metrics reflect 100% of spans ` +
        'while span export honors the configured sampling rate'
    );
    return new AlwaysRecordSampler(rootSampler);
  }

  private constructor(rootSampler: Sampler) {
    if (rootSampler == null) {
      throw new Error('rootSampler is null/undefined. It must be provided');
    }
    this.rootSampler = rootSampler;
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: SpanAttributes,
    links: Link[]
  ): SamplingResult {
    const result: SamplingResult = this.rootSampler.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links
    );
    if (result.decision === SamplingDecision.NOT_RECORD) {
      return {
        decision: SamplingDecision.RECORD,
        attributes: result.attributes,
        traceState: result.traceState,
      };
    }
    return result;
  }

  toString(): string {
    return `AlwaysRecordSampler{${this.rootSampler.toString()}}`;
  }
}
