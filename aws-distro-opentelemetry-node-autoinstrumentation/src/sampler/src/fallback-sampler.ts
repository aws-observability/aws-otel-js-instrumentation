// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, Context, Link, SpanKind } from '@opentelemetry/api';
import { Sampler, SamplingDecision, SamplingResult, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { RateLimitingSampler } from './rate-limiting-sampler';

// FallbackSampler samples 1 req/sec and additional 5% of requests using TraceIdRatioBasedSampler.
export class FallbackSampler implements Sampler {
  private fixedRateSampler: TraceIdRatioBasedSampler;
  private rateLimitingSampler: RateLimitingSampler;

  constructor() {
    this.fixedRateSampler = new TraceIdRatioBasedSampler(0.05);
    this.rateLimitingSampler = new RateLimitingSampler(1);
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    const samplingResult: SamplingResult = this.rateLimitingSampler.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links
    );

    if (samplingResult.decision !== SamplingDecision.NOT_RECORD) {
      return samplingResult;
    }

    return this.fixedRateSampler.shouldSample(context, traceId);
  }

  public toString(): string {
    return 'FallbackSampler{fallback sampling with sampling config of 1 req/sec and 5% of additional requests';
  }
}
