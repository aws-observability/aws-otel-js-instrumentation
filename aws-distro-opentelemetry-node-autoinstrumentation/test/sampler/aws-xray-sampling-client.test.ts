// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import * as nock from 'nock';
import { DiagConsoleLogger } from '@opentelemetry/api';
import { AwsXraySamplingClient } from '../../src/sampler/aws-xray-sampling-client';
import {
  GetSamplingRulesResponse,
  GetSamplingTargetsBody,
  GetSamplingTargetsResponse,
} from '../../src/sampler/remote-sampler.types';

const DATA_DIR = __dirname + '/data';
const TEST_URL = 'http://127.0.0.1:2000';

describe('AwsXraySamplingClient', () => {
  it('testGetNoSamplingRules', done => {
    nock(TEST_URL).post('/GetSamplingRules').reply(200, { SamplingRuleRecords: [] });
    const client = new AwsXraySamplingClient(TEST_URL, new DiagConsoleLogger());

    client.fetchSamplingRules((response: GetSamplingRulesResponse) => {
      expect(response.SamplingRuleRecords?.length).toEqual(0);
      done();
    });
  });

  it('testGetInvalidResponse', done => {
    nock(TEST_URL).post('/GetSamplingRules').reply(200, {});
    const client = new AwsXraySamplingClient(TEST_URL, new DiagConsoleLogger());

    client.fetchSamplingRules((response: GetSamplingRulesResponse) => {
      expect(response.SamplingRuleRecords?.length).toEqual(undefined);
      done();
    });
  });

  it('testGetSamplingRuleMissingInRecords', done => {
    nock(TEST_URL)
      .post('/GetSamplingRules')
      .reply(200, { SamplingRuleRecords: [{}] });
    const client = new AwsXraySamplingClient(TEST_URL, new DiagConsoleLogger());
    client.fetchSamplingRules((response: GetSamplingRulesResponse) => {
      expect(response.SamplingRuleRecords?.length).toEqual(1);
      done();
    });
  });

  it('testDefaultValuesUsedWhenMissingPropertiesInSamplingRule', done => {
    nock(TEST_URL)
      .post('/GetSamplingRules')
      .reply(200, { SamplingRuleRecords: [{ SamplingRule: {} }] });
    const client = new AwsXraySamplingClient(TEST_URL, new DiagConsoleLogger());
    client.fetchSamplingRules((response: GetSamplingRulesResponse) => {
      expect(response.SamplingRuleRecords?.length).toEqual(1);
      expect(response.SamplingRuleRecords?.[0].SamplingRule).not.toBeUndefined();
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.Attributes).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.FixedRate).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.HTTPMethod).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.Host).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.Priority).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.ReservoirSize).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.ResourceARN).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.RuleARN).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.RuleName).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.ServiceName).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.ServiceType).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.URLPath).toEqual(undefined);
      expect(response.SamplingRuleRecords?.[0].SamplingRule?.Version).toEqual(undefined);
      done();
    });
  });

  it('testGetCorrectNumberOfSamplingRules', done => {
    const data = require(DATA_DIR + '/get-sampling-rules-response-sample.json');
    const records = data['SamplingRuleRecords'];
    nock(TEST_URL).post('/GetSamplingRules').reply(200, data);

    const client = new AwsXraySamplingClient(TEST_URL, new DiagConsoleLogger());

    client.fetchSamplingRules((response: GetSamplingRulesResponse) => {
      expect(response.SamplingRuleRecords?.length).toEqual(records.length);
      for (let i = 0; i < records.length; i++) {
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.Attributes).toEqual(records[i].SamplingRule.Attributes);
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.FixedRate).toEqual(records[i].SamplingRule.FixedRate);
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.HTTPMethod).toEqual(records[i].SamplingRule.HTTPMethod);
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.Host).toEqual(records[i].SamplingRule.Host);
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.Priority).toEqual(records[i].SamplingRule.Priority);
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.ReservoirSize).toEqual(
          records[i].SamplingRule.ReservoirSize
        );
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.ResourceARN).toEqual(
          records[i].SamplingRule.ResourceARN
        );
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.RuleARN).toEqual(records[i].SamplingRule.RuleARN);
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.RuleName).toEqual(records[i].SamplingRule.RuleName);
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.ServiceName).toEqual(
          records[i].SamplingRule.ServiceName
        );
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.ServiceType).toEqual(
          records[i].SamplingRule.ServiceType
        );
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.URLPath).toEqual(records[i].SamplingRule.URLPath);
        expect(response.SamplingRuleRecords?.[i].SamplingRule?.Version).toEqual(records[i].SamplingRule.Version);
      }
      done();
    });
  });

  it('testGetSamplingTargets', done => {
    const data = require(DATA_DIR + '/get-sampling-targets-response-sample.json');
    nock(TEST_URL).post('/SamplingTargets').reply(200, data);

    const client = new AwsXraySamplingClient(TEST_URL, new DiagConsoleLogger());

    client.fetchSamplingTargets(data, (response: GetSamplingTargetsResponse) => {
      expect(response.SamplingTargetDocuments.length).toEqual(2);
      expect(response.UnprocessedStatistics.length).toEqual(0);
      expect(response.LastRuleModification).toEqual(1707551387);
      done();
    });
  });

  it('testGetInvalidSamplingTargets', done => {
    const data = {
      LastRuleModification: null,
      SamplingTargetDocuments: null,
      UnprocessedStatistics: null,
    };
    nock(TEST_URL).post('/SamplingTargets').reply(200, data);

    const client = new AwsXraySamplingClient(TEST_URL, new DiagConsoleLogger());

    client.fetchSamplingTargets(data as unknown as GetSamplingTargetsBody, (response: GetSamplingTargetsResponse) => {
      expect(response.SamplingTargetDocuments).toBe(null);
      expect(response.UnprocessedStatistics).toBe(null);
      expect(response.LastRuleModification).toBe(null);
      done();
    });
  });
});
