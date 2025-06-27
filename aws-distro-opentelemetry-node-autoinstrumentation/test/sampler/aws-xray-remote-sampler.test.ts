// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, Span, SpanKind } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { SamplingDecision, Tracer } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SEMRESATTRS_CLOUD_PLATFORM, SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { expect } from 'expect';
import * as nock from 'nock';
import * as sinon from 'sinon';
import { _AwsXRayRemoteSampler, AwsXRayRemoteSampler } from '../../src/sampler/aws-xray-remote-sampler';

const DATA_DIR_SAMPLING_RULES = __dirname + '/data/test-remote-sampler_sampling-rules-response-sample.json';
const DATA_DIR_SAMPLING_TARGETS = __dirname + '/data/test-remote-sampler_sampling-targets-response-sample.json';
const TEST_URL = 'http://localhost:2000';

describe('AwsXrayRemoteSampler', () => {
  it('testCreateRemoteSamplerWithEmptyResource', () => {
    const sampler: AwsXRayRemoteSampler = new AwsXRayRemoteSampler({ resource: Resource.EMPTY });

    expect((sampler as any)._root._root.rulePoller).not.toBeFalsy();
    expect((sampler as any)._root._root.rulePollingIntervalMillis).toEqual(300 * 1000);
    expect((sampler as any)._root._root.samplingClient).not.toBeFalsy();
    expect((sampler as any)._root._root.ruleCache).not.toBeFalsy();
    expect((sampler as any)._root._root.clientId).toMatch(/[a-f0-9]{24}/);
  });

  it('testCreateRemoteSamplerWithPopulatedResource', () => {
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'test-service-name',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'test-cloud-platform',
    });
    const sampler = new AwsXRayRemoteSampler({ resource: resource });

    expect((sampler as any)._root._root.rulePoller).not.toBeFalsy();
    expect((sampler as any)._root._root.rulePollingIntervalMillis).toEqual(300 * 1000);
    expect((sampler as any)._root._root.samplingClient).not.toBeFalsy();
    expect((sampler as any)._root._root.ruleCache).not.toBeFalsy();
    expect(((sampler as any)._root._root.ruleCache as any).samplerResource.attributes).toEqual(resource.attributes);
    expect((sampler as any)._root._root.clientId).toMatch(/[a-f0-9]{24}/);
  });

  it('testCreateRemoteSamplerWithAllFieldsPopulated', () => {
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'test-service-name',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'test-cloud-platform',
    });
    const sampler = new AwsXRayRemoteSampler({
      resource: resource,
      endpoint: 'http://abc.com',
      pollingInterval: 120, // seconds
    });

    expect((sampler as any)._root._root.rulePoller).not.toBeFalsy();
    expect((sampler as any)._root._root.rulePollingIntervalMillis).toEqual(120 * 1000);
    expect((sampler as any)._root._root.samplingClient).not.toBeFalsy();
    expect((sampler as any)._root._root.ruleCache).not.toBeFalsy();
    expect(((sampler as any)._root._root.ruleCache as any).samplerResource.attributes).toEqual(resource.attributes);
    expect((sampler as any)._root._root.awsProxyEndpoint).toEqual('http://abc.com');
    expect((sampler as any)._root._root.clientId).toMatch(/[a-f0-9]{24}/);
  });

  it('testUpdateSamplingRulesAndTargetsWithPollersAndShouldSampled', done => {
    nock(TEST_URL).post('/GetSamplingRules').reply(200, require(DATA_DIR_SAMPLING_RULES));
    nock(TEST_URL).post('/SamplingTargets').reply(200, require(DATA_DIR_SAMPLING_TARGETS));
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'test-service-name',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'test-cloud-platform',
    });

    // Patch default target polling interval
    const tmp = (_AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval;
    (_AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = () => {
      return 0.2; // seconds
    };
    const sampler = new AwsXRayRemoteSampler({
      resource: resource,
    });

    setTimeout(() => {
      expect(((sampler as any)._root._root.ruleCache as any).ruleAppliers[0].samplingRule.RuleName).toEqual('test');
      expect(
        sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, { abc: '1234' }, []).decision
      ).toEqual(SamplingDecision.NOT_RECORD);

      setTimeout(() => {
        // restore function
        (_AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = tmp;

        expect(
          sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, { abc: '1234' }, []).decision
        ).toEqual(SamplingDecision.RECORD_AND_SAMPLED);
        expect(
          sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, { abc: '1234' }, []).decision
        ).toEqual(SamplingDecision.RECORD_AND_SAMPLED);
        expect(
          sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, { abc: '1234' }, []).decision
        ).toEqual(SamplingDecision.RECORD_AND_SAMPLED);

        done();
      }, 300);
    }, 10);
  });

  it('testLargeReservoir', done => {
    nock(TEST_URL).post('/GetSamplingRules').reply(200, require(DATA_DIR_SAMPLING_RULES));
    nock(TEST_URL).post('/SamplingTargets').reply(200, require(DATA_DIR_SAMPLING_TARGETS));
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'test-service-name',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'test-cloud-platform',
    });
    const attributes = { abc: '1234' };

    // Patch default target polling interval
    const tmp = (_AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval;
    (_AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = () => {
      return 0.2; // seconds
    };
    const sampler = new AwsXRayRemoteSampler({
      resource: resource,
    });

    setTimeout(() => {
      expect(((sampler as any)._root._root.ruleCache as any).ruleAppliers[0].samplingRule.RuleName).toEqual('test');
      expect(sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, attributes, []).decision).toEqual(
        SamplingDecision.NOT_RECORD
      );

      setTimeout(() => {
        let sampled = 0;
        for (let i = 0; i < 100000; i++) {
          if (
            sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, attributes, []).decision !==
            SamplingDecision.NOT_RECORD
          ) {
            sampled++;
          }
        }

        // restore function
        (_AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = tmp;

        expect((sampler as any)._root._root.ruleCache.ruleAppliers[0].reservoirSampler.quota).toEqual(100000);
        expect(sampled).toEqual(100000);
        done();
      }, 2000);
    }, 100);
  });

  it('testSomeReservoir', done => {
    nock(TEST_URL).post('/GetSamplingRules').reply(200, require(DATA_DIR_SAMPLING_RULES));
    nock(TEST_URL).post('/SamplingTargets').reply(200, require(DATA_DIR_SAMPLING_TARGETS));
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'test-service-name',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'test-cloud-platform',
    });
    const attributes = { abc: 'non-matching attribute value, use default rule' };

    // Patch default target polling interval
    const tmp = (_AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval;
    (_AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = () => {
      return 2; // seconds
    };
    const sampler = new AwsXRayRemoteSampler({
      resource: resource,
    });

    setTimeout(() => {
      expect(((sampler as any)._root._root.ruleCache as any).ruleAppliers[0].samplingRule.RuleName).toEqual('test');
      expect(sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, attributes, []).decision).toEqual(
        SamplingDecision.NOT_RECORD
      );

      setTimeout(() => {
        const clock = sinon.useFakeTimers(Date.now());
        clock.tick(2000);
        let sampled = 0;
        for (let i = 0; i < 100000; i++) {
          if (
            sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, attributes, []).decision !==
            SamplingDecision.NOT_RECORD
          ) {
            sampled++;
          }
        }
        clock.restore();
        // restore function
        (_AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = tmp;
        expect(sampled).toEqual(100);
        done();
      }, 2000);
    }, 300);
  });

  it('generates valid ClientId', () => {
    const clientId: string = _AwsXRayRemoteSampler['generateClientId']();
    const match: RegExpMatchArray | null = clientId.match(/[0-9a-z]{24}/g);
    expect(match).not.toBeNull();
  });

  it('toString()', () => {
    expect(new AwsXRayRemoteSampler({ resource: Resource.EMPTY }).toString()).toEqual(
      'AwsXRayRemoteSampler{root=ParentBased{root=_AwsXRayRemoteSampler{awsProxyEndpoint=http://localhost:2000, rulePollingIntervalMillis=300000}, remoteParentSampled=AlwaysOnSampler, remoteParentNotSampled=AlwaysOffSampler, localParentSampled=AlwaysOnSampler, localParentNotSampled=AlwaysOffSampler}'
    );
  });

  it('ParentBased AwsXRayRemoteSampler creates expected Statistics from the 1 Span with no Parent, disregarding 2 Child Spans', done => {
    const defaultRuleDir = __dirname + '/data/get-sampling-rules-response-sample-sample-all.json';
    nock(TEST_URL).post('/GetSamplingRules').reply(200, require(defaultRuleDir));

    const sampler: AwsXRayRemoteSampler = new AwsXRayRemoteSampler({ resource: Resource.EMPTY });
    const tracerProvider: NodeTracerProvider = new NodeTracerProvider({ sampler: sampler });
    const tracer: Tracer = tracerProvider.getTracer('test');

    setTimeout(() => {
      tracer.startActiveSpan('test0', span0 => {
        const span1: Span = tracer.startSpan('test1');
        const span2: Span = tracer.startSpan('test2');
        span2.end();
        span1.end();
        span0.end();

        // span1 and span2 are child spans of root span0
        // For AwsXRayRemoteSampler (ParentBased), expect only span0 to update statistics
        expect((sampler as any)._root._root.ruleCache.ruleAppliers[0].statistics.RequestCount).toBe(1);
        expect((sampler as any)._root._root.ruleCache.ruleAppliers[0].statistics.SampleCount).toBe(1);
        done();
      });
    }, 100);
  });

  it('Non-ParentBased _AwsXRayRemoteSampler creates expected Statistics based on all 3 Spans, disregarding Parent Span Sampling Decision', done => {
    const defaultRuleDir = __dirname + '/data/get-sampling-rules-response-sample-sample-all.json';
    nock(TEST_URL).post('/GetSamplingRules').reply(200, require(defaultRuleDir));

    const sampler: _AwsXRayRemoteSampler = new _AwsXRayRemoteSampler({ resource: Resource.EMPTY });
    const tracerProvider: NodeTracerProvider = new NodeTracerProvider({ sampler: sampler });
    const tracer: Tracer = tracerProvider.getTracer('test');

    setTimeout(() => {
      tracer.startActiveSpan('test0', span0 => {
        const span1: Span = tracer.startSpan('test1');
        const span2: Span = tracer.startSpan('test2');
        span2.end();
        span1.end();
        span0.end();

        // span1 and span2 are child spans of root span0
        // For _AwsXRayRemoteSampler (Non-ParentBased), expect all 3 spans to update statistics
        expect((sampler as any).ruleCache.ruleAppliers[0].statistics.RequestCount).toBe(3);
        expect((sampler as any).ruleCache.ruleAppliers[0].statistics.SampleCount).toBe(3);
        done();
      });
    }, 100);
  });
});
