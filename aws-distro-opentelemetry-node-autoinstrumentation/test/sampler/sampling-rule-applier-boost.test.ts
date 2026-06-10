// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import { SamplingRuleApplier } from '../../src/sampler/sampling-rule-applier';

const createApplier = (name: string = 'TestRule'): SamplingRuleApplier => {
  return new SamplingRuleApplier({
    RuleName: name,
    Priority: 1,
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

describe('SamplingRuleApplier - Boost Statistics', () => {
  describe('countTrace', () => {
    it('increments TotalCount', () => {
      const applier = createApplier();
      applier.countTrace('trace-1');
      const stats = applier.snapshotBoostStatistics();
      expect(stats.TotalCount).toBe(1);
    });

    it('deduplicates by traceId', () => {
      const applier = createApplier();
      applier.countTrace('trace-1');
      applier.countTrace('trace-1');
      applier.countTrace('trace-1');
      const stats = applier.snapshotBoostStatistics();
      expect(stats.TotalCount).toBe(1);
    });

    it('counts distinct traceIds', () => {
      const applier = createApplier();
      applier.countTrace('trace-1');
      applier.countTrace('trace-2');
      applier.countTrace('trace-3');
      const stats = applier.snapshotBoostStatistics();
      expect(stats.TotalCount).toBe(3);
    });
  });

  describe('countAnomalyTrace', () => {
    it('increments AnomalyCount', () => {
      const applier = createApplier();
      applier.countAnomalyTrace(false);
      const stats = applier.snapshotBoostStatistics();
      expect(stats.AnomalyCount).toBe(1);
      expect(stats.SampledAnomalyCount).toBe(0);
    });

    it('increments SampledAnomalyCount when sampled', () => {
      const applier = createApplier();
      applier.countAnomalyTrace(true);
      const stats = applier.snapshotBoostStatistics();
      expect(stats.AnomalyCount).toBe(1);
      expect(stats.SampledAnomalyCount).toBe(1);
    });
  });

  describe('snapshotBoostStatistics', () => {
    it('resets counters after snapshot', () => {
      const applier = createApplier();
      applier.countTrace('trace-1');
      applier.countTrace('trace-2');
      applier.countAnomalyTrace(true);

      const first = applier.snapshotBoostStatistics();
      expect(first.TotalCount).toBe(2);
      expect(first.AnomalyCount).toBe(1);

      const second = applier.snapshotBoostStatistics();
      expect(second.TotalCount).toBe(0);
      expect(second.AnomalyCount).toBe(0);
      expect(second.SampledAnomalyCount).toBe(0);
    });

    it('clears seenTraceIds so same trace can be counted again after reset', () => {
      const applier = createApplier();
      applier.countTrace('trace-1');
      applier.snapshotBoostStatistics(); // resets

      applier.countTrace('trace-1'); // same ID, should count again
      const stats = applier.snapshotBoostStatistics();
      expect(stats.TotalCount).toBe(1);
    });
  });
});
