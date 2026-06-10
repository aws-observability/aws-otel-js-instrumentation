// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { resourceFromAttributes } from '@opentelemetry/resources';
import { expect } from 'expect';
import { RuleCache, XRSR_TRACE_STATE_KEY } from '../../src/sampler/rule-cache';
import { SamplingRuleApplier } from '../../src/sampler/sampling-rule-applier';

const createRule = (name: string, priority: number = 1): SamplingRuleApplier => {
  return new SamplingRuleApplier({
    RuleName: name,
    Priority: priority,
    ReservoirSize: 0,
    FixedRate: 0.01,
    ServiceName: '*',
    ServiceType: '*',
    Host: '*',
    HTTPMethod: '*',
    URLPath: '*',
    ResourceARN: '*',
    Version: 1,
  });
};

describe('RuleCache - Hash Maps', () => {
  it('XRSR_TRACE_STATE_KEY is "xrsr"', () => {
    expect(XRSR_TRACE_STATE_KEY).toBe('xrsr');
  });

  describe('hashRuleName', () => {
    it('produces 16-char hex string', () => {
      const hash = RuleCache.hashRuleName('TestRule');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is deterministic', () => {
      expect(RuleCache.hashRuleName('MyRule')).toBe(RuleCache.hashRuleName('MyRule'));
    });

    it('produces different hashes for different names', () => {
      expect(RuleCache.hashRuleName('RuleA')).not.toBe(RuleCache.hashRuleName('RuleB'));
    });

    it('matches Python SHA-256 first 8 bytes output', () => {
      // Python: hashlib.sha256("Default".encode("utf-8")).digest()[:8].hex()
      // = "21b111cbfe6e8fca"
      const hash = RuleCache.hashRuleName('Default');
      expect(hash).toBe('21b111cbfe6e8fca');
    });
  });

  describe('updateRules builds hash maps', () => {
    it('getHashForRule returns hash after updateRules', () => {
      const cache = new RuleCache(resourceFromAttributes({}));
      cache.updateRules([createRule('PaymentRule'), createRule('Default', 10000)]);

      const hash = cache.getHashForRule('PaymentRule');
      expect(hash).toBeDefined();
      expect(hash).toHaveLength(16);
    });

    it('getRuleApplierByHash returns correct applier', () => {
      const cache = new RuleCache(resourceFromAttributes({}));
      cache.updateRules([createRule('PaymentRule'), createRule('Default', 10000)]);

      const hash = cache.getHashForRule('PaymentRule')!;
      const applier = cache.getRuleApplierByHash(hash);
      expect(applier).toBeDefined();
      expect(applier!.samplingRule.RuleName).toBe('PaymentRule');
    });

    it('getRuleApplierByHash returns undefined for unknown hash', () => {
      const cache = new RuleCache(resourceFromAttributes({}));
      cache.updateRules([createRule('PaymentRule')]);

      expect(cache.getRuleApplierByHash('0000000000000000')).toBeUndefined();
    });

    it('rebuilds maps on updateRules', () => {
      const cache = new RuleCache(resourceFromAttributes({}));
      cache.updateRules([createRule('RuleA')]);
      expect(cache.getHashForRule('RuleA')).toBeDefined();
      expect(cache.getHashForRule('RuleB')).toBeUndefined();

      cache.updateRules([createRule('RuleB')]);
      expect(cache.getHashForRule('RuleA')).toBeUndefined();
      expect(cache.getHashForRule('RuleB')).toBeDefined();
    });
  });

  describe('createBoostStatisticsDocuments', () => {
    it('returns empty array when no boost stats', () => {
      const cache = new RuleCache(resourceFromAttributes({}));
      cache.updateRules([createRule('TestRule')]);
      const docs = cache.createBoostStatisticsDocuments('client-id', 'my-service');
      expect(docs).toHaveLength(0);
    });

    it('returns per-rule docs after counting', () => {
      const cache = new RuleCache(resourceFromAttributes({}));
      const rule = createRule('TestRule');
      cache.updateRules([rule]);

      rule.countTrace('trace-1');
      rule.countTrace('trace-2');
      rule.countAnomalyTrace(true);

      const docs = cache.createBoostStatisticsDocuments('client-id', 'my-service');
      expect(docs).toHaveLength(1);
      expect(docs[0].RuleName).toBe('TestRule');
      expect(docs[0].TotalCount).toBe(2);
      expect(docs[0].AnomalyCount).toBe(1);
      expect(docs[0].SampledAnomalyCount).toBe(1);
    });
  });
});
