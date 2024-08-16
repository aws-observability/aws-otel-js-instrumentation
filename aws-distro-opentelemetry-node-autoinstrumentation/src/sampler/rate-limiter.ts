// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * The RateLimiter keeps track of the current reservoir quota balance available (measured via available time)
 * If enough time has elapsed, the RateLimiter will allow quota balance to be consumed/taken (decrease available time)
 * A RateLimitingSampler uses this RateLimiter to determine if it should sample or not based on the quota balance available.
 */
export class RateLimiter {
  // Quota assigned to client to dictate maximum quota balance that can be consumed per second.
  private quota: number;
  private MAX_BALANCE_MILLIS: number;
  // Used to measure current quota balance.
  private walletFloorMillis: number;

  constructor(quota: number, maxBalanceInSeconds: number = 1) {
    this.MAX_BALANCE_MILLIS = maxBalanceInSeconds * 1000.0;
    this.quota = quota;
    this.walletFloorMillis = Date.now();
    // current "balance" would be `ceiling - floor`
  }

  public take(cost: number = 1): boolean {
    if (this.quota === 0) {
      return false;
    }

    const quotaPerMillis: number = this.quota / 1000.0;

    // assume divide by zero not possible
    const costInMillis: number = cost / quotaPerMillis;

    const walletCeilingMillis: number = Date.now();
    let currentBalanceMillis: number = walletCeilingMillis - this.walletFloorMillis;
    currentBalanceMillis = Math.min(currentBalanceMillis, this.MAX_BALANCE_MILLIS);
    const pendingRemainingBalanceMillis: number = currentBalanceMillis - costInMillis;
    if (pendingRemainingBalanceMillis >= 0) {
      this.walletFloorMillis = walletCeilingMillis - pendingRemainingBalanceMillis;
      return true;
    }
    // No changes to the wallet state
    return false;
  }
}
