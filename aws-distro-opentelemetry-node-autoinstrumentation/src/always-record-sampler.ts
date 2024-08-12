// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Context, Link, SpanAttributes, SpanKind } from '@opentelemetry/api';
import { Sampler, SamplingDecision, SamplingResult } from '@opentelemetry/sdk-trace-base';

/**
 * This sampler will return the sampling result of the provided {@link #rootSampler}, unless the
 * sampling result contains the sampling decision {@link SamplingDecision.NOT_RECORD}, in which case, a
 * new sampling result will be returned that is functionally equivalent to the original, except that
 * it contains the sampling decision {@link SamplingDecision.RECORD}. This ensures that all
 * spans are recorded, with no change to sampling.
 *
 * <p>The intended use case of this sampler is to provide a means of sending all spans to a
 * processor without having an impact on the sampling rate. This may be desirable if a user wishes
 * to count or otherwise measure all spans produced in a service, without incurring the cost of 100%
 * sampling.
 */
export class AlwaysRecordSampler implements Sampler {
  private rootSampler: Sampler;

  public static create(rootSampler: Sampler): AlwaysRecordSampler {
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
    const rootSamplerSamplingResult: SamplingResult = this.rootSampler.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links
    );
    if (rootSamplerSamplingResult.decision === SamplingDecision.NOT_RECORD) {
      return this.wrapResultWithRecordOnlyResult(rootSamplerSamplingResult);
    }
    return rootSamplerSamplingResult;
  }

  toString(): string {
    return `AlwaysRecordSampler{${this.rootSampler.toString()}}`;
  }

  wrapResultWithRecordOnlyResult(result: SamplingResult) {
    const wrappedResult: SamplingResult = {
      decision: SamplingDecision.RECORD,
      attributes: result.attributes,
      traceState: result.traceState,
    };
    return wrappedResult;
  }
}
