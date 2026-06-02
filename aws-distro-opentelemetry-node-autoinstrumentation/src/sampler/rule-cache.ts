// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { Attributes, diag } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import {
  ISamplingStatistics,
  SamplingStatisticsDocument,
  SamplingTargetDocument,
  TargetMap,
} from './remote-sampler.types';
import { SamplingRuleApplier } from './sampling-rule-applier';

// The cache expires 1 hour after the last refresh time.
const RULE_CACHE_TTL_MILLIS: number = 60 * 60 * 1000;

// 10 second default sampling targets polling interval
export const DEFAULT_TARGET_POLLING_INTERVAL_SECONDS: number = 10;

// W3C tracestate key for X-Ray Sampling Rule propagation
export const XRSR_TRACE_STATE_KEY: string = 'xrsr';

export class RuleCache {
  private ruleAppliers: SamplingRuleApplier[];
  private lastUpdatedEpochMillis: number;
  private samplerResource: Resource;
  private ruleToHashMap: Map<string, string> = new Map();
  private hashToRuleMap: Map<string, string> = new Map();

  constructor(samplerResource: Resource) {
    this.ruleAppliers = [];
    this.samplerResource = samplerResource;
    this.lastUpdatedEpochMillis = Date.now();
  }

  public isExpired(): boolean {
    const nowInMillis: number = Date.now();
    return nowInMillis > this.lastUpdatedEpochMillis + RULE_CACHE_TTL_MILLIS;
  }

  public getMatchedRule(attributes: Attributes): SamplingRuleApplier | undefined {
    return this.ruleAppliers.find(
      rule => rule.matches(attributes, this.samplerResource) || rule.samplingRule.RuleName === 'Default'
    );
  }

  private sortRulesByPriority(): void {
    this.ruleAppliers.sort((rule1: SamplingRuleApplier, rule2: SamplingRuleApplier): number => {
      if (rule1.samplingRule.Priority === rule2.samplingRule.Priority) {
        return rule1.samplingRule.RuleName < rule2.samplingRule.RuleName ? -1 : 1;
      }
      return rule1.samplingRule.Priority - rule2.samplingRule.Priority;
    });
  }

  public updateRules(newRuleAppliers: SamplingRuleApplier[]): void {
    const oldRuleAppliersMap: { [key: string]: SamplingRuleApplier } = {};

    this.ruleAppliers.forEach((rule: SamplingRuleApplier) => {
      oldRuleAppliersMap[rule.samplingRule.RuleName] = rule;
    });

    newRuleAppliers.forEach((newRule: SamplingRuleApplier, index: number) => {
      const ruleNameToCheck: string = newRule.samplingRule.RuleName;
      if (ruleNameToCheck in oldRuleAppliersMap) {
        const oldRule: SamplingRuleApplier = oldRuleAppliersMap[ruleNameToCheck];
        if (newRule.samplingRule.equals(oldRule.samplingRule)) {
          newRuleAppliers[index] = oldRule;
        }
      }
    });
    this.ruleAppliers = newRuleAppliers;

    // Rebuild hash maps for xrsr tracestate propagation
    // Python: _rule_cache.py lines 346-349
    this.ruleToHashMap = new Map(
      newRuleAppliers.map(a => [a.samplingRule.RuleName, RuleCache.hashRuleName(a.samplingRule.RuleName)])
    );
    this.hashToRuleMap = new Map(
      Array.from(this.ruleToHashMap.entries()).map(([k, v]) => [v, k])
    );

    // sort ruleAppliers by priority and update lastUpdatedEpochMillis
    this.sortRulesByPriority();
    this.lastUpdatedEpochMillis = Date.now();
  }

  // Python: _rule_cache.py lines 400-402
  // SHA-256, truncated to first 8 bytes → 16-char hex string
  public static hashRuleName(ruleName: string): string {
    const hash = createHash('sha256').update(ruleName, 'utf-8').digest();
    return hash.subarray(0, 8).toString('hex');
  }

  public getRuleApplierByHash(hash: string): SamplingRuleApplier | undefined {
    const ruleName = this.hashToRuleMap.get(hash);
    if (!ruleName) return undefined;
    return this.ruleAppliers.find(r => r.samplingRule.RuleName === ruleName);
  }

  public getHashForRule(ruleName: string): string | undefined {
    return this.ruleToHashMap.get(ruleName);
  }

  public createSamplingStatisticsDocuments(clientId: string): SamplingStatisticsDocument[] {
    const statisticsDocuments: SamplingStatisticsDocument[] = [];

    this.ruleAppliers.forEach((rule: SamplingRuleApplier) => {
      const statistics: ISamplingStatistics = rule.snapshotStatistics();
      const nowInSeconds: number = Math.floor(Date.now() / 1000);

      const samplingStatisticsDoc: SamplingStatisticsDocument = {
        ClientID: clientId,
        RuleName: rule.samplingRule.RuleName,
        Timestamp: nowInSeconds,
        RequestCount: statistics.RequestCount,
        BorrowCount: statistics.BorrowCount,
        SampledCount: statistics.SampleCount,
      };

      statisticsDocuments.push(samplingStatisticsDoc);
    });
    return statisticsDocuments;
  }

  // Python: _rule_cache.py lines 383-393 — get_all_statistics collects per-rule boost stats
  public createBoostStatisticsDocuments(clientId: string, serviceName: string): Array<{
    ClientID: string;
    RuleName: string;
    ServiceName: string;
    Timestamp: number;
    TotalCount: number;
    AnomalyCount: number;
    SampledAnomalyCount: number;
  }> {
    const boostDocs: Array<{
      ClientID: string;
      RuleName: string;
      ServiceName: string;
      Timestamp: number;
      TotalCount: number;
      AnomalyCount: number;
      SampledAnomalyCount: number;
    }> = [];

    const nowInSeconds = Math.floor(Date.now() / 1000);
    for (const rule of this.ruleAppliers) {
      const boostStats = rule.snapshotBoostStatistics();
      if (boostStats.TotalCount > 0) {
        boostDocs.push({
          ClientID: clientId,
          RuleName: rule.samplingRule.RuleName,
          ServiceName: serviceName,
          Timestamp: nowInSeconds,
          TotalCount: boostStats.TotalCount,
          AnomalyCount: boostStats.AnomalyCount,
          SampledAnomalyCount: boostStats.SampledAnomalyCount,
        });
      }
    }
    return boostDocs;
  }

  // Update ruleAppliers based on the targets fetched from X-Ray service
  public updateTargets(targetDocuments: TargetMap, lastRuleModification: number): [boolean, number] {
    let minPollingInterval: number | undefined = undefined;
    let nextPollingInterval: number = DEFAULT_TARGET_POLLING_INTERVAL_SECONDS;
    this.ruleAppliers.forEach((rule: SamplingRuleApplier, index: number) => {
      const target: SamplingTargetDocument = targetDocuments[rule.samplingRule.RuleName];
      if (target) {
        this.ruleAppliers[index] = rule.withTarget(target);
        if (typeof target.Interval === 'number') {
          if (minPollingInterval === undefined || minPollingInterval > target.Interval) {
            minPollingInterval = target.Interval;
          }
        }
      } else {
        diag.debug('Invalid sampling target: missing rule name');
      }
    });

    if (typeof minPollingInterval === 'number') {
      nextPollingInterval = minPollingInterval;
    }

    const refreshSamplingRules: boolean = lastRuleModification * 1000 > this.lastUpdatedEpochMillis;
    return [refreshSamplingRules, nextPollingInterval];
  }
}
