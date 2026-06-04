// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CloudWatch SEH (Sparse Exponential Histogram) implementation for TypeScript.
 *
 * This module implements the SEH1 algorithm used by AWS CloudWatch for efficient
 * distribution aggregation with ~10% relative error. Based on the Go implementation:
 * https://github.com/aws/amazon-cloudwatch-agent/blob/main/metric/distribution/seh1/seh1_distribution.go
 *
 * The SEH algorithm uses exponentially-spaced buckets to compress large numbers of
 * samples into a compact representation suitable for CloudWatch EMF (Embedded Metric Format).
 */

// Constants for SEH1 algorithm
// Bucket width factor: log(1.1) gives ~10% relative error per bucket
export const BUCKET_FACTOR = Math.log(1.1); // ~0.0953101798043

// Pre-computed reciprocal for multiplication instead of division (faster)
export const BUCKET_FACTOR_INV = 1.0 / BUCKET_FACTOR;

// Special bucket number for exact zero values
export const BUCKET_FOR_ZERO = -32768; // int16 min equivalent

// Supported value range: use Number.MAX_VALUE as practical upper bound
// (JS cannot represent 2^360 precisely in Number type, but duration values
// will never approach this range)
export const MIN_VALUE = -Number.MAX_VALUE;
export const MAX_VALUE = Number.MAX_VALUE;

/**
 * Sparse Exponential Histogram for distribution aggregation.
 *
 * Maintains a sparse map of exponentially-spaced buckets to efficiently
 * aggregate duration samples while preserving statistical properties.
 */
export class SEHHistogram {
  maxBuckets: number;
  buckets: Map<number, number>;
  minimum: number | null;
  maximum: number | null;
  sum: number;
  count: number;

  constructor(maxBuckets: number = 100) {
    this.maxBuckets = maxBuckets;
    this.buckets = new Map();
    this.minimum = null;
    this.maximum = null;
    this.sum = 0;
    this.count = 0;
  }

  /**
   * Record a value into the histogram with optional weight.
   *
   * @param value - The value to record (e.g., duration in nanoseconds)
   * @param weight - Weight for this sample (default: 1.0)
   * @returns True if the value was recorded, false if rejected
   * @throws Error if validation fails (NaN, Infinity, invalid range, or weight <= 0)
   */
  record(value: number, weight: number = 1.0): boolean {
    // Validate input
    this.validateInput(value, weight);

    // Check bucket limit (only if adding a new bucket)
    const bucketNum = this.getBucket(value);
    if (!this.buckets.has(bucketNum) && this.buckets.size >= this.maxBuckets) {
      // Bucket limit reached - reject new distinct values
      return false;
    }

    // Update statistics
    this.count += weight;
    this.sum += value * weight;

    if (this.minimum === null || value < this.minimum) {
      this.minimum = value;
    }

    if (this.maximum === null || value > this.maximum) {
      this.maximum = value;
    }

    // Update bucket count
    const existing = this.buckets.get(bucketNum);
    if (existing !== undefined) {
      this.buckets.set(bucketNum, existing + weight);
    } else {
      this.buckets.set(bucketNum, weight);
    }

    return true;
  }

  /**
   * Get the histogram as parallel arrays of values and counts.
   *
   * @returns Tuple of [values, counts] sorted by bucket number (ascending).
   *          Compatible with CloudWatch EMF histogram structure.
   */
  getValuesAndCounts(): [number[], number[]] {
    if (this.buckets.size === 0) {
      return [[], []];
    }

    // Sort buckets by bucket number
    const sortedEntries = Array.from(this.buckets.entries()).sort((a, b) => a[0] - b[0]);

    const values: number[] = [];
    const counts: number[] = [];

    for (const [bucketNum, count] of sortedEntries) {
      const value = this.recoverValue(bucketNum);
      values.push(value);
      counts.push(count);
    }

    return [values, counts];
  }

  /**
   * Validate input value and weight.
   *
   * @throws Error if validation fails
   */
  private validateInput(value: number, weight: number): void {
    if (Number.isNaN(value)) {
      throw new Error('Value cannot be NaN');
    }
    if (Number.isNaN(weight)) {
      throw new Error('Weight cannot be NaN');
    }
    if (!Number.isFinite(value)) {
      throw new Error('Value cannot be Infinity');
    }
    if (!Number.isFinite(weight)) {
      throw new Error('Weight cannot be Infinity');
    }
    if (weight <= 0) {
      throw new Error(`Weight must be positive, got ${weight}`);
    }
  }

  /**
   * Calculate the bucket number for a given value.
   *
   * The bucket calculation uses logarithmic spacing:
   * bucket_number = floor(log(value) / log(1.1))
   *
   * Zero values map to a special bucket (BUCKET_FOR_ZERO = -32768).
   */
  getBucket(value: number): number {
    if (value === 0) {
      return BUCKET_FOR_ZERO;
    }

    // For negative values, use absolute value for bucket calculation
    const absValue = Math.abs(value);

    // Calculate bucket: floor(log(absValue) * (1/BUCKET_FACTOR))
    // Uses pre-computed reciprocal for multiplication instead of division
    let bucketNum = Math.floor(Math.log(absValue) * BUCKET_FACTOR_INV);

    // Apply sign
    if (value < 0) {
      bucketNum = -bucketNum;
    }

    return bucketNum;
  }

  /**
   * Recover the representative value from a bucket number.
   *
   * Uses the geometric midpoint of the exponential bucket range:
   * value = exp((bucketNum + 0.5) * log(1.1))
   *
   * The 0.5 offset selects the center of the bucket's range.
   */
  recoverValue(bucketNum: number): number {
    if (bucketNum === BUCKET_FOR_ZERO) {
      return 0.0;
    }

    // Calculate midpoint value: exp((bucketNum + 0.5) * BUCKET_FACTOR)
    return Math.exp((bucketNum + 0.5) * BUCKET_FACTOR);
  }

  /**
   * Record a value without input validation.
   *
   * Use this for internal timing data where the values are guaranteed to be
   * finite, non-NaN numbers with weight 1. Avoids the overhead of
   * validateInput() on the hot path.
   *
   * @param value - The value to record (must be a finite number)
   * @returns True if the value was recorded, false if bucket limit reached
   */
  recordUnsafe(value: number): boolean {
    // Inline optimized bucket calculation for positive values (duration is always > 0).
    // Skips zero check, Math.abs(), and negative sign handling that getBucket() does.
    const bucketNum = value > 0 ? Math.floor(Math.log(value) * BUCKET_FACTOR_INV) : BUCKET_FOR_ZERO;

    if (!this.buckets.has(bucketNum) && this.buckets.size >= this.maxBuckets) {
      return false;
    }

    this.count += 1;
    this.sum += value;

    if (this.minimum === null || value < this.minimum) {
      this.minimum = value;
    }
    if (this.maximum === null || value > this.maximum) {
      this.maximum = value;
    }

    const existing = this.buckets.get(bucketNum);
    this.buckets.set(bucketNum, existing !== undefined ? existing + 1 : 1);

    return true;
  }

  /**
   * Check if the histogram is empty (no samples recorded).
   */
  isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Get summary statistics for the histogram.
   */
  getStatistics(): { min: number; max: number; sum: number; count: number } {
    return {
      min: this.minimum !== null ? this.minimum : 0,
      max: this.maximum !== null ? this.maximum : 0,
      sum: this.sum,
      count: this.count,
    };
  }

  /**
   * String representation for debugging.
   */
  toString(): string {
    return (
      `SEHHistogram(count=${this.count}, buckets=${this.buckets.size}, ` +
      `min=${this.minimum}, max=${this.maximum}, sum=${this.sum})`
    );
  }
}
