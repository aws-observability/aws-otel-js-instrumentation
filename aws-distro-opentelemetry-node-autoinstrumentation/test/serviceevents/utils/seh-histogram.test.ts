// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { SEHHistogram, BUCKET_FACTOR, BUCKET_FOR_ZERO } from '../../../src/serviceevents/utils/seh-histogram';

describe('SEHHistogram', function () {
  describe('constructor', function () {
    it('should create empty histogram with default maxBuckets', function () {
      const h = new SEHHistogram();
      expect(h.maxBuckets).toBe(100);
      expect(h.isEmpty()).toBe(true);
      expect(h.count).toBe(0);
      expect(h.sum).toBe(0);
      expect(h.minimum).toBe(null);
      expect(h.maximum).toBe(null);
    });

    it('should accept custom maxBuckets', function () {
      const h = new SEHHistogram(50);
      expect(h.maxBuckets).toBe(50);
    });
  });

  describe('record()', function () {
    it('should record a single value', function () {
      const h = new SEHHistogram();
      expect(h.record(100)).toBe(true);
      expect(h.count).toBe(1);
      expect(h.sum).toBe(100);
      expect(h.minimum).toBe(100);
      expect(h.maximum).toBe(100);
    });

    it('should record multiple values', function () {
      const h = new SEHHistogram();
      h.record(100);
      h.record(200);
      h.record(300);
      expect(h.count).toBe(3);
      expect(h.sum).toBe(600);
      expect(h.minimum).toBe(100);
      expect(h.maximum).toBe(300);
    });

    it('should record zero values', function () {
      const h = new SEHHistogram();
      h.record(0);
      expect(h.count).toBe(1);
      expect(h.sum).toBe(0);
      expect(h.minimum).toBe(0);
      expect(h.maximum).toBe(0);
    });

    it('should record negative values', function () {
      const h = new SEHHistogram();
      h.record(-50);
      expect(h.count).toBe(1);
      expect(h.sum).toBe(-50);
      expect(h.minimum).toBe(-50);
      expect(h.maximum).toBe(-50);
    });

    it('should record with custom weight', function () {
      const h = new SEHHistogram();
      h.record(100, 5.0);
      expect(h.count).toBe(5);
      expect(h.sum).toBe(500);
    });

    it('should reject NaN value', function () {
      const h = new SEHHistogram();
      expect(() => h.record(NaN)).toThrow('Value cannot be NaN');
    });

    it('should reject NaN weight', function () {
      const h = new SEHHistogram();
      expect(() => h.record(100, NaN)).toThrow('Weight cannot be NaN');
    });

    it('should reject Infinity value', function () {
      const h = new SEHHistogram();
      expect(() => h.record(Infinity)).toThrow('Value cannot be Infinity');
    });

    it('should reject negative Infinity value', function () {
      const h = new SEHHistogram();
      expect(() => h.record(-Infinity)).toThrow('Value cannot be Infinity');
    });

    it('should reject Infinity weight', function () {
      const h = new SEHHistogram();
      expect(() => h.record(100, Infinity)).toThrow('Weight cannot be Infinity');
    });

    it('should reject zero weight', function () {
      const h = new SEHHistogram();
      expect(() => h.record(100, 0)).toThrow('Weight must be positive');
    });

    it('should reject negative weight', function () {
      const h = new SEHHistogram();
      expect(() => h.record(100, -1)).toThrow('Weight must be positive');
    });

    it('should respect maxBuckets limit', function () {
      const h = new SEHHistogram(3);
      // Record values that go into different buckets
      h.record(1);
      h.record(10);
      h.record(100);
      // This should be rejected (4th distinct bucket)
      expect(h.record(10000)).toBe(false);
      expect(h.buckets.size).toBe(3);
    });

    it('should allow values in existing buckets beyond maxBuckets', function () {
      const h = new SEHHistogram(3);
      h.record(1);
      h.record(10);
      h.record(100);
      // Same bucket as existing value — should be accepted
      expect(h.record(1)).toBe(true);
      expect(h.count).toBe(4);
    });
  });

  describe('recordUnsafe()', function () {
    it('should record without validation', function () {
      const h = new SEHHistogram();
      expect(h.recordUnsafe(100)).toBe(true);
      expect(h.count).toBe(1);
      expect(h.sum).toBe(100);
      expect(h.minimum).toBe(100);
      expect(h.maximum).toBe(100);
    });

    it('should respect maxBuckets limit', function () {
      const h = new SEHHistogram(2);
      h.recordUnsafe(1);
      h.recordUnsafe(1000);
      expect(h.recordUnsafe(1000000)).toBe(false);
    });

    it('should produce same results as record() for valid input', function () {
      const h1 = new SEHHistogram();
      const h2 = new SEHHistogram();
      const values = [10, 50, 100, 500, 1000, 5000];

      for (const v of values) {
        h1.record(v);
        h2.recordUnsafe(v);
      }

      expect(h1.count).toBe(h2.count);
      expect(h1.sum).toBe(h2.sum);
      expect(h1.minimum).toBe(h2.minimum);
      expect(h1.maximum).toBe(h2.maximum);
    });
  });

  describe('getBucket()', function () {
    it('should return BUCKET_FOR_ZERO for zero', function () {
      const h = new SEHHistogram();
      expect(h.getBucket(0)).toBe(BUCKET_FOR_ZERO);
    });

    it('should return consistent bucket for same value', function () {
      const h = new SEHHistogram();
      expect(h.getBucket(100)).toBe(h.getBucket(100));
    });

    it('should return different buckets for values far apart', function () {
      const h = new SEHHistogram();
      expect(h.getBucket(1)).not.toBe(h.getBucket(1000000));
    });

    it('should return negative bucket numbers for negative values', function () {
      const h = new SEHHistogram();
      const bucketPos = h.getBucket(100);
      const bucketNeg = h.getBucket(-100);
      expect(bucketNeg).toBe(-bucketPos);
    });
  });

  describe('recoverValue()', function () {
    it('should return 0 for BUCKET_FOR_ZERO', function () {
      const h = new SEHHistogram();
      expect(h.recoverValue(BUCKET_FOR_ZERO)).toBe(0.0);
    });

    it('should return value close to original for positive bucket', function () {
      const h = new SEHHistogram();
      const bucket = h.getBucket(1000);
      const recovered = h.recoverValue(bucket);
      // With ~10% relative error, recovered should be within 10% of 1000
      expect(recovered).toBeGreaterThan(900);
      expect(recovered).toBeLessThan(1100);
    });

    it('should recover a NEGATIVE value with its sign intact (round-trip)', function () {
      const h = new SEHHistogram();
      // getBucket negates the bucket number for negative inputs; recoverValue must
      // re-apply the sign rather than returning a positive magnitude.
      const bucket = h.getBucket(-1000);
      const recovered = h.recoverValue(bucket);
      expect(recovered).toBeLessThan(0);
      // Magnitude still within ~10% of 1000.
      expect(recovered).toBeGreaterThan(-1100);
      expect(recovered).toBeLessThan(-900);
    });
  });

  describe('getValuesAndCounts()', function () {
    it('should return empty arrays for empty histogram', function () {
      const h = new SEHHistogram();
      const [values, counts] = h.getValuesAndCounts();
      expect(values).toEqual([]);
      expect(counts).toEqual([]);
    });

    it('should return sorted values and counts', function () {
      const h = new SEHHistogram();
      h.record(1000);
      h.record(100);
      h.record(1000); // same bucket as first

      const [values, counts] = h.getValuesAndCounts();
      expect(values.length).toBeGreaterThanOrEqual(1);
      expect(counts.length).toBe(values.length);

      // Values should be sorted ascending
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
      }
    });
  });

  describe('getStatistics()', function () {
    it('should return zeros for empty histogram', function () {
      const h = new SEHHistogram();
      const stats = h.getStatistics();
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(0);
      expect(stats.sum).toBe(0);
      expect(stats.count).toBe(0);
    });

    it('should return correct statistics', function () {
      const h = new SEHHistogram();
      h.record(100);
      h.record(200);
      h.record(300);
      const stats = h.getStatistics();
      expect(stats.min).toBe(100);
      expect(stats.max).toBe(300);
      expect(stats.sum).toBe(600);
      expect(stats.count).toBe(3);
    });
  });

  describe('isEmpty()', function () {
    it('should return true for new histogram', function () {
      const h = new SEHHistogram();
      expect(h.isEmpty()).toBe(true);
    });

    it('should return false after recording', function () {
      const h = new SEHHistogram();
      h.record(100);
      expect(h.isEmpty()).toBe(false);
    });
  });

  describe('toString()', function () {
    it('should return string representation', function () {
      const h = new SEHHistogram();
      h.record(100);
      const str = h.toString();
      expect(str).toContain('SEHHistogram');
      expect(str).toContain('count=1');
    });
  });

  describe('constants', function () {
    it('BUCKET_FACTOR should be approximately log(1.1)', function () {
      expect(Math.abs(BUCKET_FACTOR - Math.log(1.1))).toBeLessThan(0.0001);
    });

    it('BUCKET_FOR_ZERO should be -32768', function () {
      expect(BUCKET_FOR_ZERO).toBe(-32768);
    });
  });
});
