// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixed-window token bucket rate limiter.
 *
 * Limits captures to N per second per instrumentation.
 * 1-second windows, counter resets on window rollover.
 *
 * In Node.js (single-threaded), no atomic operations needed.
 */
export class CaptureRateLimiter {
  private readonly maxCapturesPerSecond: number;
  private windowStart: number;
  private count: number;

  constructor(maxCapturesPerSecond: number = 5) {
    this.maxCapturesPerSecond = Math.max(1, maxCapturesPerSecond);
    this.windowStart = 0;
    this.count = 0;
  }

  /**
   * Try to acquire a capture permit.
   * Returns true if within the rate limit, false if exceeded.
   */
  tryAcquire(nowMs: number = Date.now()): boolean {
    const windowStartMs = Math.floor(nowMs / 1000) * 1000;

    if (windowStartMs !== this.windowStart) {
      // New window — reset counter
      this.windowStart = windowStartMs;
      this.count = 0;
    }

    if (this.count >= this.maxCapturesPerSecond) {
      return false;
    }

    this.count++;
    return true;
  }

  getMaxCapturesPerSecond(): number {
    return this.maxCapturesPerSecond;
  }

  getCurrentCount(): number {
    return this.count;
  }
}
