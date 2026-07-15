// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { CaptureRateLimiter } from '../../src/dynamic-instrumentation/rate-limiter';

describe('CaptureRateLimiter', function () {
  it('should allow captures within the limit', function () {
    const limiter = new CaptureRateLimiter(5);
    const now = 1000000;
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
  });

  it('should reject captures over the limit', function () {
    const limiter = new CaptureRateLimiter(3);
    const now = 1000000;
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(false);
    expect(limiter.tryAcquire(now)).toBe(false);
  });

  it('should reset counter on new window', function () {
    const limiter = new CaptureRateLimiter(2);
    expect(limiter.tryAcquire(1000)).toBe(true);
    expect(limiter.tryAcquire(1000)).toBe(true);
    expect(limiter.tryAcquire(1000)).toBe(false);
    // New second window
    expect(limiter.tryAcquire(2000)).toBe(true);
    expect(limiter.tryAcquire(2000)).toBe(true);
    expect(limiter.tryAcquire(2000)).toBe(false);
  });

  it('should default to 5 captures per second', function () {
    const limiter = new CaptureRateLimiter();
    expect(limiter.getMaxCapturesPerSecond()).toBe(5);
  });

  it('should enforce minimum of 1 capture per second', function () {
    const limiter = new CaptureRateLimiter(0);
    expect(limiter.getMaxCapturesPerSecond()).toBe(1);
  });

  it('should track current count', function () {
    const limiter = new CaptureRateLimiter(5);
    const now = 1000000;
    expect(limiter.getCurrentCount()).toBe(0);
    limiter.tryAcquire(now);
    expect(limiter.getCurrentCount()).toBe(1);
    limiter.tryAcquire(now);
    expect(limiter.getCurrentCount()).toBe(2);
  });
});
