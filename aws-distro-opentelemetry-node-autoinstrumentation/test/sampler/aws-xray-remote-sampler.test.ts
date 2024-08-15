// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DiagConsoleLogger, SpanKind, context, diag } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { SEMRESATTRS_CLOUD_PLATFORM, SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { expect } from 'expect';
import * as nock from 'nock';
import * as sinon from 'sinon';
import { AwsXRayRemoteSampler } from '../../src/sampler/aws-xray-remote-sampler';

const DATA_DIR_SAMPLING_RULES = __dirname + '/data/test-remote-sampler_sampling-rules-response-sample.json';
const DATA_DIR_SAMPLING_TARGETS = __dirname + '/data/test-remote-sampler_sampling-targets-response-sample.json';
const TEST_URL = 'http://localhost:2000';

diag.setLogger(new DiagConsoleLogger(), opentelemetry.core.getEnv().OTEL_LOG_LEVEL);

describe('AwsXrayRemoteSampler', () => {
  it('testCreateRemoteSamplerWithEmptyResource', () => {
    const sampler: AwsXRayRemoteSampler = new AwsXRayRemoteSampler({ resource: Resource.EMPTY });

    expect(sampler.getRulePoller()).not.toBeFalsy();
    expect(sampler.getRulePollingIntervalMillis()).toEqual(300 * 1000);
    expect(sampler.getSamplingClient()).not.toBeFalsy();
    expect(sampler.getRuleCache()).not.toBeFalsy();
    expect(sampler.getClientId()).toMatch(/[a-f0-9]{24}/);
  });

  it('testCreateRemoteSamplerWithPopulatedResource', () => {
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'test-service-name',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'test-cloud-platform',
    });
    const sampler = new AwsXRayRemoteSampler({ resource: resource });

    expect(sampler.getRulePoller()).not.toBeFalsy();
    expect(sampler.getRulePollingIntervalMillis()).toEqual(300 * 1000);
    expect(sampler.getSamplingClient()).not.toBeFalsy();
    expect(sampler.getRuleCache()).not.toBeFalsy();
    expect(sampler.getRuleCache().getSamplerResource().attributes).toEqual(resource.attributes);
    expect(sampler.getClientId()).toMatch(/[a-f0-9]{24}/);
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

    expect(sampler.getRulePoller()).not.toBeFalsy();
    expect(sampler.getRulePollingIntervalMillis()).toEqual(120 * 1000);
    expect(sampler.getSamplingClient()).not.toBeFalsy();
    expect(sampler.getRuleCache()).not.toBeFalsy();
    expect(sampler.getRuleCache().getSamplerResource().attributes).toEqual(resource.attributes);
    expect(sampler.getAwsProxyEndpoint()).toEqual('http://abc.com');
    expect(sampler.getClientId()).toMatch(/[a-f0-9]{24}/);
  });

  it('testUpdateSamplingRulesAndTargetsWithPollersAndShouldSampled', done => {
    nock(TEST_URL).post('/GetSamplingRules').reply(200, require(DATA_DIR_SAMPLING_RULES));
    nock(TEST_URL).post('/SamplingTargets').reply(200, require(DATA_DIR_SAMPLING_TARGETS));
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'test-service-name',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'test-cloud-platform',
    });

    // Patch default target polling interval
    const tmp = (AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval;
    (AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = () => {
      return 0.2; // seconds
    };
    const sampler = new AwsXRayRemoteSampler({
      resource: resource,
    });

    setTimeout(() => {
      expect(sampler.getRuleCache().getRuleAppliers()[0].samplingRule.RuleName).toEqual('test');
      expect(
        sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, { abc: '1234' }, []).decision
      ).toEqual(SamplingDecision.NOT_RECORD);

      setTimeout(() => {
        expect(
          sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, { abc: '1234' }, []).decision
        ).toEqual(SamplingDecision.RECORD_AND_SAMPLED);
        expect(
          sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, { abc: '1234' }, []).decision
        ).toEqual(SamplingDecision.RECORD_AND_SAMPLED);
        expect(
          sampler.shouldSample(context.active(), '1234', 'name', SpanKind.CLIENT, { abc: '1234' }, []).decision
        ).toEqual(SamplingDecision.RECORD_AND_SAMPLED);

        // reset function
        (AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = tmp;
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
    const tmp = (AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval;
    (AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = () => {
      return 0.2; // seconds
    };
    const sampler = new AwsXRayRemoteSampler({
      resource: resource,
    });

    setTimeout(() => {
      expect(sampler.getRuleCache().getRuleAppliers()[0].samplingRule.RuleName).toEqual('test');
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
        expect((sampler.getRuleCache().getRuleAppliers()[0] as any).reservoirSampler._root.quota).toEqual(100000);
        expect(sampled).toEqual(100000);
        // reset function
        (AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = tmp;
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
    const tmp = (AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval;
    (AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = () => {
      return 2; // seconds
    };
    const sampler = new AwsXRayRemoteSampler({
      resource: resource,
    });

    setTimeout(() => {
      expect(sampler.getRuleCache().getRuleAppliers()[0].samplingRule.RuleName).toEqual('test');
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
        expect(sampled).toEqual(100);
        // reset function
        (AwsXRayRemoteSampler.prototype as any).getDefaultTargetPollingInterval = tmp;
        clock.restore();
        done();
      }, 2000);
    }, 100);
  });

  it('generates valid ClientId', () => {
    const clientId: string = (AwsXRayRemoteSampler as any).generateClientId();
    const match: RegExpMatchArray | null = clientId.match(/[0-9a-z]{24}/g);
    expect(match).not.toBeNull();
  });
});
