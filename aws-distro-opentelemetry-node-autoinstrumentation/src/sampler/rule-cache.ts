// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, diag } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ISamplingStatistics, SamplingStatisticsDocument, SamplingTargetDocument, TargetMap } from './remote-sampler.types';
import { SamplingRuleApplier } from './sampling-rule-applier';

// The cache expires 1 hour after the last refresh time.
const RULE_CACHE_TTL_MILLIS: number = 60 * 60 * 1000;

// 10 second default sampling targets polling interval
export const DEFAULT_TARGET_POLLING_INTERVAL_SECONDS: number = 10;

export class RuleCache {
  private ruleAppliers: SamplingRuleApplier[];
  private lastUpdatedEpochMillis: number;
  private samplerResource: Resource;

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

    // sort ruleAppliers by priority and update lastUpdatedEpochMillis
    this.sortRulesByPriority();
    this.lastUpdatedEpochMillis = Date.now();
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

  // Update ruleAppliers based on the targets fetched from X-Ray service
  public updateTargets(targetDocuments: TargetMap, lastRuleModification: number): [boolean, number] {
    let minPollingInteral: number | undefined = undefined;
    let nextPollingInterval: number = DEFAULT_TARGET_POLLING_INTERVAL_SECONDS;
    this.ruleAppliers.forEach((rule: SamplingRuleApplier, index: number) => {
      const target: SamplingTargetDocument = targetDocuments[rule.samplingRule.RuleName];
      if (target) {
        this.ruleAppliers[index] = rule.withTarget(target);
        if (target.Interval) {
          if (minPollingInteral === undefined || minPollingInteral > target.Interval) {
            minPollingInteral = target.Interval;
          }
        }
      } else {
        diag.debug('Invalid sampling target: missing rule name');
      }
    });

    if (minPollingInteral) {
      nextPollingInterval = minPollingInteral;
    }

    const refreshSamplingRules: boolean = lastRuleModification * 1000 > this.lastUpdatedEpochMillis;
    return [refreshSamplingRules, nextPollingInterval];
  }
}
