// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { InstrumentationType, ConfigurationStatus, DisableReason } from './types';
import { CaptureRateLimiter } from '../rate-limiter';

/**
 * Runtime state for a single instrumentation configuration.
 *
 * Tracks hit counts, disabled status, and status reporting flags.
 * State is preserved across polling cycles for unchanged configurations.
 */
export class InstrumentationState {
  readonly locationHash: string;
  readonly maxHits: number;
  readonly expiresAt: number | null;
  readonly instrumentationType: InstrumentationType;
  readonly rateLimiter: CaptureRateLimiter;

  hitCount: number = 0;
  isDisabled: boolean = false;
  disableReason: DisableReason | null = null;
  hitInLastPeriod: boolean = false;

  // Set to true after V8 breakpoint is confirmed set. Only installed configs report READY.
  installed: boolean = false;

  // Status reporting tracking — ensure one-time statuses are only reported once
  readyReported: boolean = false;
  disabledReported: boolean = false;
  errorReported: boolean = false;

  constructor(
    locationHash: string,
    maxHits: number,
    expiresAt: number | null,
    instrumentationType: InstrumentationType,
    capturesPerSecond: number = 5
  ) {
    this.locationHash = locationHash;
    this.maxHits = maxHits;
    this.expiresAt = expiresAt;
    this.instrumentationType = instrumentationType;
    this.rateLimiter = new CaptureRateLimiter(capturesPerSecond);
  }

  /**
   * Record a hit and check disable conditions.
   * Returns true if capture should proceed, false if disabled or rate-limited.
   *
   * Rate-limited hits do NOT count toward maxHits — hitCount tracks captures
   * actually allowed, so maxHits equals the number of snapshots emitted
   * (matching the Java and Python SDKs).
   */
  recordHit(): boolean {
    if (this.isDisabled) return false;

    // The breakpoint is being hit, even if this capture ends up throttled —
    // keeps ACTIVE status reporting truthful.
    this.hitInLastPeriod = true;

    // Check maxHits before consuming a rate-limiter token (BREAKPOINT only —
    // PROBE has MAX_SAFE_INTEGER). hitCount is incremented only on allowed
    // captures, so maxHits=2 means exactly 2 captures.
    if (this.hitCount >= this.maxHits) {
      this.isDisabled = true;
      this.disableReason = DisableReason.MAX_HITS_REACHED;
      return false;
    }

    // Check rate limit — a throttled hit does not consume maxHits budget
    if (!this.rateLimiter.tryAcquire()) {
      return false;
    }

    this.hitCount++;
    return true;
  }

  /**
   * Check if expired. Only relevant for BREAKPOINT configs.
   */
  checkExpiry(nowMs: number = Date.now()): boolean {
    if (this.isDisabled) return true;
    if (this.expiresAt !== null && nowMs >= this.expiresAt) {
      this.isDisabled = true;
      this.disableReason = DisableReason.EXPIRED;
      return true;
    }
    return false;
  }

  /**
   * Get the current status for reporting.
   */
  getStatus(): ConfigurationStatus {
    if (this.isDisabled) return ConfigurationStatus.DISABLED;
    if (this.hitCount > 0) return ConfigurationStatus.ACTIVE;
    return ConfigurationStatus.READY;
  }

  /**
   * Reset the hit-in-last-period flag after status reporting.
   */
  resetPeriodFlag(): void {
    this.hitInLastPeriod = false;
  }
}
