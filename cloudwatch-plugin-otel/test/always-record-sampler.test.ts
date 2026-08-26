// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Context, SpanKind } from '@opentelemetry/api';
import { Sampler, SamplingDecision, SamplingResult } from '@opentelemetry/sdk-trace-base';
import * as assert from 'assert';
import { AlwaysRecordSampler } from '../src/always-record-sampler';

function delegateReturning(decision: SamplingDecision): Sampler {
  return {
    shouldSample(): SamplingResult {
      return { decision, attributes: { keep: 'me' } };
    },
    toString: () => 'Delegate',
  };
}

const args: [Context, string, string, SpanKind, {}, []] = [{} as Context, 'trace', 'span', SpanKind.SERVER, {}, []];

describe('AlwaysRecordSampler', () => {
  it('upgrades DROP (NOT_RECORD) to RECORD_ONLY (RECORD), preserving attributes', () => {
    const sampler = AlwaysRecordSampler.create(delegateReturning(SamplingDecision.NOT_RECORD));
    const result = sampler.shouldSample(...args);
    assert.strictEqual(result.decision, SamplingDecision.RECORD);
    assert.deepStrictEqual(result.attributes, { keep: 'me' });
  });

  it('passes RECORD_AND_SAMPLED through unchanged', () => {
    const sampler = AlwaysRecordSampler.create(delegateReturning(SamplingDecision.RECORD_AND_SAMPLED));
    assert.strictEqual(sampler.shouldSample(...args).decision, SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('passes RECORD through unchanged', () => {
    const sampler = AlwaysRecordSampler.create(delegateReturning(SamplingDecision.RECORD));
    assert.strictEqual(sampler.shouldSample(...args).decision, SamplingDecision.RECORD);
  });

  it('describes itself as wrapping the delegate', () => {
    const sampler = AlwaysRecordSampler.create(delegateReturning(SamplingDecision.RECORD));
    assert.strictEqual(sampler.toString(), 'AlwaysRecordSampler{Delegate}');
  });

  it('rejects a null delegate', () => {
    assert.throws(() => AlwaysRecordSampler.create(null as unknown as Sampler));
  });
});
