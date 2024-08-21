// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes } from '@opentelemetry/api/build/src/common/Attributes';
import { Resource } from '@opentelemetry/resources';
import {
  SEMATTRS_AWS_LAMBDA_INVOKED_ARN,
  SEMATTRS_HTTP_HOST,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_TARGET,
  SEMATTRS_HTTP_URL,
  SEMRESATTRS_CLOUD_PLATFORM,
  SEMRESATTRS_SERVICE_NAME,
} from '@opentelemetry/semantic-conventions';
import { expect } from 'expect';
import { SamplingRule } from '../../src/sampler/sampling-rule';
import { SamplingRuleApplier } from '../../src/sampler/sampling-rule-applier';

const DATA_DIR = __dirname + '/data';

describe('SamplingRuleApplier', () => {
  it('testApplierAttributeMatchingFromXRayResponse', () => {
    const sampleData = require(DATA_DIR + '/get-sampling-rules-response-sample-2.json');

    const allRules = sampleData['SamplingRuleRecords'];
    const defaultRule: SamplingRule = allRules[0]['SamplingRule'];
    const samplingRuleApplier = new SamplingRuleApplier(defaultRule);

    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'test_service_name',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'test_cloud_platform',
    });

    const attr: Attributes = {
      [SEMATTRS_HTTP_TARGET]: 'target',
      [SEMATTRS_HTTP_METHOD]: 'method',
      [SEMATTRS_HTTP_URL]: 'url',
      [SEMATTRS_HTTP_HOST]: 'host',
      ['foo']: 'bar',
      ['abc']: '1234',
    };

    expect(samplingRuleApplier.matches(attr, resource)).toEqual(true);
  });

  it('testApplierMatchesWithAllAttributes', () => {
    const rule = new SamplingRule({
      Attributes: { abc: '123', def: '4?6', ghi: '*89' },
      FixedRate: 0.11,
      HTTPMethod: 'GET',
      Host: 'localhost',
      Priority: 20,
      ReservoirSize: 1,
      // Note that ResourceARN is usually only able to be "*"
      // See: https://docs.aws.amazon.com/xray/latest/devguide/xray-console-sampling.html#xray-console-sampling-options  # noqa: E501
      ResourceARN: 'arn:aws:lambda:us-west-2:123456789012:function:my-function',
      RuleARN: 'arn:aws:xray:us-east-1:999999999999:sampling-rule/test',
      RuleName: 'test',
      ServiceName: 'myServiceName',
      ServiceType: 'AWS::Lambda::Function',
      URLPath: '/helloworld',
      Version: 1,
    });

    const attributes: Attributes = {
      [SEMATTRS_HTTP_HOST]: 'localhost',
      [SEMATTRS_HTTP_METHOD]: 'GET',
      [SEMATTRS_AWS_LAMBDA_INVOKED_ARN]: 'arn:aws:lambda:us-west-2:123456789012:function:my-function',
      [SEMATTRS_HTTP_TARGET]: 'http://127.0.0.1:5000/helloworld',
      ['abc']: '123',
      ['def']: '456',
      ['ghi']: '789',
    };

    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'myServiceName',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'aws_lambda',
    });

    const ruleApplier = new SamplingRuleApplier(rule);

    expect(ruleApplier.matches(attributes, resource)).toEqual(true);
  });
  it('testApplierWildCardAttributesMatchesSpanAttributes', () => {
    const rule = new SamplingRule({
      Attributes: {
        attr1: '*',
        attr2: '*',
        attr3: 'HelloWorld',
        attr4: 'Hello*',
        attr5: '*World',
        attr6: '?ello*',
        attr7: 'Hell?W*d',
        attr8: '*.World',
        attr9: '*.World',
      },
      FixedRate: 0.11,
      HTTPMethod: '*',
      Host: '*',
      Priority: 20,
      ReservoirSize: 1,
      ResourceARN: '*',
      RuleARN: 'arn:aws:xray:us-east-1:999999999999:sampling-rule/test',
      RuleName: 'test',
      ServiceName: '*',
      ServiceType: '*',
      URLPath: '*',
      Version: 1,
    });
    const ruleApplier = new SamplingRuleApplier(rule);

    const attributes: Attributes = {
      attr1: '',
      attr2: 'HelloWorld',
      attr3: 'HelloWorld',
      attr4: 'HelloWorld',
      attr5: 'HelloWorld',
      attr6: 'HelloWorld',
      attr7: 'HelloWorld',
      attr8: 'Hello.World',
      attr9: 'Bye.World',
    };

    expect(ruleApplier.matches(attributes, Resource.EMPTY)).toEqual(true);
  });

  it('testApplierWildCardAttributesMatchesHttpSpanAttributes', () => {
    const ruleApplier = new SamplingRuleApplier(
      new SamplingRule({
        Attributes: {},
        FixedRate: 0.11,
        HTTPMethod: '*',
        Host: '*',
        Priority: 20,
        ReservoirSize: 1,
        ResourceARN: '*',
        RuleARN: 'arn:aws:xray:us-east-1:999999999999:sampling-rule/test',
        RuleName: 'test',
        ServiceName: '*',
        ServiceType: '*',
        URLPath: '*',
        Version: 1,
      })
    );

    const attributes: Attributes = {
      [SEMATTRS_HTTP_HOST]: 'localhost',
      [SEMATTRS_HTTP_METHOD]: 'GET',
      [SEMATTRS_HTTP_TARGET]: 'http://127.0.0.1:5000/helloworld',
    };

    expect(ruleApplier.matches(attributes, Resource.EMPTY)).toEqual(true);
  });

  it('testApplierWildCardAttributesMatchesWithEmptyAttributes', () => {
    const ruleApplier = new SamplingRuleApplier(
      new SamplingRule({
        Attributes: {},
        FixedRate: 0.11,
        HTTPMethod: '*',
        Host: '*',
        Priority: 20,
        ReservoirSize: 1,
        ResourceARN: '*',
        RuleARN: 'arn:aws:xray:us-east-1:999999999999:sampling-rule/test',
        RuleName: 'test',
        ServiceName: '*',
        ServiceType: '*',
        URLPath: '*',
        Version: 1,
      })
    );

    const attributes: Attributes = {};
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'myServiceName',
      [SEMRESATTRS_CLOUD_PLATFORM]: 'aws_ec2',
    });

    expect(ruleApplier.matches(attributes, resource)).toEqual(true);
    expect(ruleApplier.matches({}, resource)).toEqual(true);
    expect(ruleApplier.matches(attributes, Resource.EMPTY)).toEqual(true);
    expect(ruleApplier.matches({}, Resource.EMPTY)).toEqual(true);
    expect(ruleApplier.matches(attributes, new Resource({}))).toEqual(true);
    expect(ruleApplier.matches({}, new Resource({}))).toEqual(true);
  });

  it('testApplierMatchesWithHttpUrlWithHttpTargetUndefined', () => {
    const ruleApplier = new SamplingRuleApplier(
      new SamplingRule({
        Attributes: {},
        FixedRate: 0.11,
        HTTPMethod: '*',
        Host: '*',
        Priority: 20,
        ReservoirSize: 1,
        ResourceARN: '*',
        RuleARN: 'arn:aws:xray:us-east-1:999999999999:sampling-rule/test',
        RuleName: 'test',
        ServiceName: '*',
        ServiceType: '*',
        URLPath: '/somerandompath',
        Version: 1,
      })
    );

    const attributes: Attributes = {
      [SEMATTRS_HTTP_URL]: 'https://somerandomurl.com/somerandompath',
    };
    const resource = new Resource({});

    expect(ruleApplier.matches(attributes, resource)).toEqual(true);
    expect(ruleApplier.matches(attributes, Resource.EMPTY)).toEqual(true);
    expect(ruleApplier.matches(attributes, new Resource({}))).toEqual(true);
  });
});
