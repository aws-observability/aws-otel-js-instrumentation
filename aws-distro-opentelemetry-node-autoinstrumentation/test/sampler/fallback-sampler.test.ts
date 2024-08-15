// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import * as sinon from 'sinon';
import { SpanKind, context } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { FallbackSampler } from '../../src/sampler/fallback-sampler';

let clock: sinon.SinonFakeTimers;
describe('FallBackSampler', () => {
  beforeEach(() => {
    clock = sinon.useFakeTimers(Date.now());
  })
  afterEach(() => {
    try {
      clock.restore();
    }
    catch {
      // do nothing
    }
  })
  it('testShouldSample', () => {
    const sampler = new FallbackSampler();

    sampler.shouldSample(context.active(), '1234', "name", SpanKind.CLIENT, {}, []);

    // 0 seconds passed, 0 quota available
    var sampled = 0
    for (let i = 0; i < 30; i++) {
      if (sampler.shouldSample(context.active(), '1234', "name", SpanKind.CLIENT, {}, []).decision != SamplingDecision.NOT_RECORD) {
        sampled += 1;
      }
    }
    expect(sampled).toEqual(0)

    // 0.4 seconds passed, 0.4 quota available
    sampled = 0
    clock.tick(0.4 * 1000)
    for (let i = 0; i < 30; i++) {
      if (sampler.shouldSample(context.active(), '1234', "name", SpanKind.CLIENT, {}, []).decision != SamplingDecision.NOT_RECORD) {
        sampled += 1;
      }
    }
    expect(sampled).toEqual(0)

    // 0.8 seconds passed, 0.8 quota available
    sampled = 0
    clock.tick(0.4 * 1000)
    for (let i = 0; i < 30; i++) {
      if (sampler.shouldSample(context.active(), '1234', "name", SpanKind.CLIENT, {}, []).decision != SamplingDecision.NOT_RECORD) {
        sampled += 1;
      }
    }
    expect(sampled).toEqual(0)

    // 1.2 seconds passed, 1 quota consumed, 0 quota available
    sampled = 0
    clock.tick(0.4 * 1000)
    for (let i = 0; i < 30; i++) {
      if (sampler.shouldSample(context.active(), '1234', "name", SpanKind.CLIENT, {}, []).decision != SamplingDecision.NOT_RECORD) {
        sampled += 1;
      }
    }
    expect(sampled).toEqual(1)

    // 1.6 seconds passed, 0.4 quota available
    sampled = 0
    clock.tick(0.4 * 1000)
    for (let i = 0; i < 30; i++) {
      if (sampler.shouldSample(context.active(), '1234', "name", SpanKind.CLIENT, {}, []).decision != SamplingDecision.NOT_RECORD) {
        sampled += 1;
      }
    }
    expect(sampled).toEqual(0)

    // 2.0 seconds passed, 0.8 quota available
    sampled = 0
    clock.tick(0.4 * 1000)
    for (let i = 0; i < 30; i++) {
      if (sampler.shouldSample(context.active(), '1234', "name", SpanKind.CLIENT, {}, []).decision != SamplingDecision.NOT_RECORD) {
        sampled += 1;
      }
    }
    expect(sampled).toEqual(0)

    // 2.4 seconds passed, one more quota consumed, 0 quota available
    sampled = 0
    clock.tick(0.4 * 1000)
    for (let i = 0; i < 30; i++) {
      if (sampler.shouldSample(context.active(), '1234', "name", SpanKind.CLIENT, {}, []).decision != SamplingDecision.NOT_RECORD) {
        sampled += 1;
      }
    }
    expect(sampled).toEqual(1)

    // 100 seconds passed, only one quota can be consumed
    sampled = 0
    clock.tick(100 * 1000)
    for (let i = 0; i < 30; i++) {
      if (sampler.shouldSample(context.active(), '1234', "name", SpanKind.CLIENT, {}, []).decision != SamplingDecision.NOT_RECORD) {
        sampled += 1;
      }
    }
    expect(sampled).toEqual(1)
  });
});
