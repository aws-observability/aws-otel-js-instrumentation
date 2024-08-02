// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, SpanKind, TraceState, context, createTraceState } from '@opentelemetry/api';
import {
  AlwaysOffSampler,
  RandomIdGenerator,
  Sampler,
  SamplingDecision,
  SamplingResult,
} from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { AlwaysRecordSampler } from '../src/always-record-sampler';

let mockedSampler: Sampler;
let sampler: AlwaysRecordSampler;

describe('AlwaysRecordSamplerTest', () => {
  beforeEach(() => {
    mockedSampler = new AlwaysOffSampler();
    sampler = AlwaysRecordSampler.create(mockedSampler);
  });

  it('testGetDescription', () => {
    mockedSampler.toString = () => 'mockDescription';
    expect(sampler.toString()).toEqual('AlwaysRecordSampler{mockDescription}');
  });

  it('testRecordAndSampleSamplingDecision', () => {
    validateShouldSample(SamplingDecision.RECORD_AND_SAMPLED, SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('testRecordOnlySamplingDecision', () => {
    validateShouldSample(SamplingDecision.RECORD, SamplingDecision.RECORD);
  });

  it('testDropSamplingDecision', () => {
    validateShouldSample(SamplingDecision.NOT_RECORD, SamplingDecision.RECORD);
  });
});

function validateShouldSample(rootDecision: SamplingDecision, expectedDecision: SamplingDecision): void {
  const rootResult: SamplingResult = buildRootSamplingResult(rootDecision);
  mockedSampler.shouldSample = () => {
    return rootResult;
  };

  const actualResult: SamplingResult = sampler.shouldSample(
    context.active(),
    new RandomIdGenerator().generateTraceId(),
    'spanName',
    SpanKind.CLIENT,
    {},
    []
  );

  if (rootDecision === expectedDecision) {
    expect(actualResult).toBe(rootResult);
    expect(actualResult.decision).toBe(rootDecision);
  } else {
    expect(actualResult).not.toBe(rootResult);
    expect(actualResult.decision).toBe(expectedDecision);
  }

  expect(actualResult.attributes).toEqual(rootResult.attributes);
  expect(actualResult.traceState).toEqual(rootResult.traceState);
}

function buildRootSamplingResult(samplingDecision: SamplingDecision): SamplingResult {
  const samplingAttr: Attributes = { key: SamplingDecision[samplingDecision] };
  const samplingTraceState: TraceState = createTraceState();
  samplingTraceState.set('key', SamplingDecision[samplingDecision]);
  const samplingResult: SamplingResult = {
    decision: samplingDecision,
    attributes: samplingAttr,
    traceState: samplingTraceState,
  };
  return samplingResult;
}
