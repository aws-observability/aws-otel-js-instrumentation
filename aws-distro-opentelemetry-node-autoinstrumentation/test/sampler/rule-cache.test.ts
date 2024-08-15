// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import * as sinon from 'sinon';
import { Resource } from '@opentelemetry/resources';
import { RuleCache } from '../../src/sampler/rule-cache';
import { SamplingRule } from '../../src/sampler/sampling-rule';
import { SamplingRuleApplier } from '../../src/sampler/sampling-rule-applier';

const createRule = (name: string, priority: number, reservoirSize: number, fixedRate: number): SamplingRuleApplier => {
  const testSamplingRule = {
    RuleName: name,
    Priority: priority,
    ReservoirSize: reservoirSize,
    FixedRate: fixedRate,
    ServiceName: '*',
    ServiceType: '*',
    Host: '*',
    HTTPMethod: '*',
    URLPath: '*',
    ResourceARN: '*',
    Version: 1,
  };
  return new SamplingRuleApplier(new SamplingRule(testSamplingRule));
};

describe('RuleCache', () => {

  it('testCacheUpdatesAndSortsRules', () => {
    // Set up default rule in rule cache
    const defaultRule = createRule('Default', 10000, 1, 0.05);
    const cache = new RuleCache(new Resource({}));
    cache.updateRules([defaultRule]);

    // Expect default rule to exist
    expect(cache.getRuleAppliers().length).toEqual(1);

    // Set up incoming rules
    const rule1 = createRule('low', 200, 0, 0.0);
    const rule2 = createRule('abc', 100, 0, 0.0);
    const rule3 = createRule('Abc', 100, 0, 0.0);
    const rule4 = createRule('ab', 100, 0, 0.0);
    const rule5 = createRule('A', 100, 0, 0.0);
    const rule6 = createRule('high', 10, 0, 0.0);
    const rules = [rule1, rule2, rule3, rule4, rule5, rule6];

    cache.updateRules(rules);

    // Default rule should be removed because it doesn't exist in the new list
    expect(cache.getRuleAppliers().length).toEqual(rules.length);
    expect(cache.getRuleAppliers()[0].samplingRule.RuleName).toEqual('high');
    expect(cache.getRuleAppliers()[1].samplingRule.RuleName).toEqual('A');
    expect(cache.getRuleAppliers()[2].samplingRule.RuleName).toEqual('Abc');
    expect(cache.getRuleAppliers()[3].samplingRule.RuleName).toEqual('ab');
    expect(cache.getRuleAppliers()[4].samplingRule.RuleName).toEqual('abc');
    expect(cache.getRuleAppliers()[5].samplingRule.RuleName).toEqual('low');
  });

  it('testRuleCacheExpirationLogic', () => {
    const clock = sinon.useFakeTimers(Date.now());

    const defaultRule = createRule('Default', 10000, 1, 0.05);
    const cache = new RuleCache(new Resource({}));
    cache.updateRules([defaultRule]);

    clock.tick(2 * 60 * 60 * 1000);

    expect(cache.isExpired()).toBe(true);
    clock.restore();
  });

  it('testUpdateCacheWithOnlyOneRuleChanged', () => {
    // Set up default rule in rule cache
    const cache = new RuleCache(new Resource({}));
    const rule1 = createRule('rule_1', 1, 0, 0.0);
    const rule2 = createRule('rule_2', 10, 0, 0.0);
    const rule3 = createRule('rule_3', 100, 0, 0.0);
    const ruleAppliers = [rule1, rule2, rule3];

    cache.updateRules(ruleAppliers);

    const ruleAppliersCopy = cache.getRuleAppliers();

    const newRule3 = createRule('new_rule_3', 5, 0, 0.0);
    const newRuleAppliers = [rule1, rule2, newRule3];
    cache.updateRules(newRuleAppliers);

    // Check rule cache is still correct length and has correct rules
    expect(cache.getRuleAppliers().length).toEqual(3);
    expect(cache.getRuleAppliers()[0].samplingRule.RuleName).toEqual('rule_1');
    expect(cache.getRuleAppliers()[1].samplingRule.RuleName).toEqual('new_rule_3');
    expect(cache.getRuleAppliers()[2].samplingRule.RuleName).toEqual('rule_2');

    // Assert before and after of rule cache
    expect(ruleAppliersCopy[0]).toEqual(cache.getRuleAppliers()[0]);
    expect(ruleAppliersCopy[1]).toEqual(cache.getRuleAppliers()[2]);
    expect(ruleAppliersCopy[2]).not.toEqual(cache.getRuleAppliers()[1]);
  });

  it('testUpdateRulesRemovesOlderRule', () => {
    // Set up default rule in rule cache
    const cache = new RuleCache(new Resource({}));
    expect(cache.getRuleAppliers().length).toEqual(0);

    const rule1 = createRule('first_rule', 200, 0, 0.0);
    const rules = [rule1];
    cache.updateRules(rules);
    expect(cache.getRuleAppliers().length).toEqual(1);
    expect(cache.getRuleAppliers()[0].samplingRule.RuleName).toEqual('first_rule');

    const replacement_rule1 = createRule('second_rule', 200, 0, 0.0);
    const replacementRules = [replacement_rule1];
    cache.updateRules(replacementRules);
    expect(cache.getRuleAppliers().length).toEqual(1);
    expect(cache.getRuleAppliers()[0].samplingRule.RuleName).toEqual('second_rule');
  });

  it('testUpdateSamplingTargets', () => {
    const rule1 = createRule('default', 10000, 1, 0.05);
    const rule2 = createRule('test', 20, 10, 0.2);
    const cache = new RuleCache(new Resource({}));
    cache.updateRules([rule1, rule2]);

    expect((cache.getRuleAppliers()[0] as any).reservoirSampler._root.quota).toEqual(1);
    expect((cache.getRuleAppliers()[0] as any).fixedRateSampler._root._ratio).toEqual(rule2.samplingRule.FixedRate);

    expect((cache.getRuleAppliers()[1] as any).reservoirSampler._root.quota).toEqual(1);
    expect((cache.getRuleAppliers()[1] as any).fixedRateSampler._root._ratio).toEqual(rule1.samplingRule.FixedRate);

    const time = Date.now() / 1000;
    const target1 = {
      FixedRate: 0.05,
      Interval: 15,
      ReservoirQuota: 1,
      ReservoirQuotaTTL: time + 10,
      RuleName: 'default',
    };
    const target2 = {
      FixedRate: 0.15,
      Interval: 12,
      ReservoirQuota: 5,
      ReservoirQuotaTTL: time + 10,
      RuleName: 'test',
    };
    const target3 = {
      FixedRate: 0.15,
      Interval: 3,
      ReservoirQuota: 5,
      ReservoirQuotaTTL: time + 10,
      RuleName: 'associated rule does not exist',
    };

    const targetMap = { default: target1, test: target2, 'associated rule does not exist': target3 };
    const [refreshSamplingRules, nextPollingInterval] = cache.updateTargets(targetMap, time - 10);
    expect(refreshSamplingRules).toEqual(false);
    expect(nextPollingInterval).toEqual(target2.Interval);

    // Ensure cache is still of length 2
    expect(cache.getRuleAppliers().length).toEqual(2);

    expect((cache.getRuleAppliers()[0] as any).reservoirSampler._root.quota).toEqual(target2.ReservoirQuota);
    expect((cache.getRuleAppliers()[0] as any).fixedRateSampler._root._ratio).toEqual(target2.FixedRate);
    expect((cache.getRuleAppliers()[1] as any).reservoirSampler._root.quota).toEqual(target1.ReservoirQuota);
    expect((cache.getRuleAppliers()[1] as any).fixedRateSampler._root._ratio).toEqual(target1.FixedRate);

    const [refreshSamplingRulesAfter, _] = cache.updateTargets(targetMap, time + 1);
    expect(refreshSamplingRulesAfter).toBe(true);
  });

  it('testGetAllStatistics', () => {
    const time = Date.now();
    const clock = sinon.useFakeTimers(time);

    const rule1 = createRule('test', 4, 2, 2.0);
    const rule2 = createRule('default', 5, 5, 5.0);

    const cache = new RuleCache(Resource.EMPTY);
    cache.updateRules([rule1, rule2]);

    clock.tick(1); // ms

    const clientId = '12345678901234567890abcd';
    const statistics = cache.createSamplingStatisticsDocuments('12345678901234567890abcd');

    // 1 ms should not be big enough to expect a timestamp difference
    expect(statistics).toEqual([
      {
        ClientID: clientId,
        RuleName: 'test',
        Timestamp: Math.floor(time / 1000),
        RequestCount: 0,
        BorrowCount: 0,
        SampledCount: 0,
      },
      {
        ClientID: clientId,
        RuleName: 'default',
        Timestamp: Math.floor(time / 1000),
        RequestCount: 0,
        BorrowCount: 0,
        SampledCount: 0,
      },
    ]);
    clock.restore();
  });
});
