// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { InstrumentationState } from '../../../src/dynamic-instrumentation/model/instrumentation-state';
import {
  InstrumentationType,
  ConfigurationStatus,
  DisableReason,
} from '../../../src/dynamic-instrumentation/model/types';

describe('InstrumentationState', function () {
  it('should start with hitCount=0 and not disabled', function () {
    const state = new InstrumentationState('hash1', 100, null, InstrumentationType.BREAKPOINT);
    expect(state.hitCount).toBe(0);
    expect(state.isDisabled).toBe(false);
    expect(state.installed).toBe(false);
  });

  it('should increment hitCount on recordHit', function () {
    const state = new InstrumentationState('hash1', 100, null, InstrumentationType.BREAKPOINT);
    state.recordHit();
    expect(state.hitCount).toBe(1);
    expect(state.hitInLastPeriod).toBe(true);
  });

  it('should disable after maxHits exceeded', function () {
    const state = new InstrumentationState('hash1', 3, null, InstrumentationType.BREAKPOINT);
    expect(state.recordHit()).toBe(true); // hit 1
    expect(state.recordHit()).toBe(true); // hit 2
    expect(state.recordHit()).toBe(true); // hit 3
    expect(state.recordHit()).toBe(false); // hit 4 — exceeds maxHits=3
    expect(state.isDisabled).toBe(true);
    expect(state.disableReason).toBe(DisableReason.MAX_HITS_REACHED);
  });

  it('should return false when already disabled', function () {
    const state = new InstrumentationState('hash1', 1, null, InstrumentationType.BREAKPOINT);
    state.recordHit(); // hit 1
    state.recordHit(); // hit 2 — disabled
    expect(state.recordHit()).toBe(false);
  });

  it('should check expiry', function () {
    const pastExpiry = Date.now() - 10000;
    const state = new InstrumentationState('hash1', 100, pastExpiry, InstrumentationType.BREAKPOINT);
    expect(state.checkExpiry()).toBe(true);
    expect(state.isDisabled).toBe(true);
    expect(state.disableReason).toBe(DisableReason.EXPIRED);
  });

  it('should not expire for future ExpiresAt', function () {
    const futureExpiry = Date.now() + 100000;
    const state = new InstrumentationState('hash1', 100, futureExpiry, InstrumentationType.BREAKPOINT);
    expect(state.checkExpiry()).toBe(false);
    expect(state.isDisabled).toBe(false);
  });

  it('should not expire when expiresAt is null', function () {
    const state = new InstrumentationState('hash1', 100, null, InstrumentationType.BREAKPOINT);
    expect(state.checkExpiry()).toBe(false);
  });

  it('should report READY status when not hit', function () {
    const state = new InstrumentationState('hash1', 100, null, InstrumentationType.BREAKPOINT);
    expect(state.getStatus()).toBe(ConfigurationStatus.READY);
  });

  it('should report ACTIVE status when hit', function () {
    const state = new InstrumentationState('hash1', 100, null, InstrumentationType.BREAKPOINT);
    state.recordHit();
    expect(state.getStatus()).toBe(ConfigurationStatus.ACTIVE);
  });

  it('should report DISABLED status when disabled', function () {
    const state = new InstrumentationState('hash1', 1, null, InstrumentationType.BREAKPOINT);
    state.recordHit();
    state.recordHit(); // exceeds maxHits
    expect(state.getStatus()).toBe(ConfigurationStatus.DISABLED);
  });

  it('should reset period flag', function () {
    const state = new InstrumentationState('hash1', 100, null, InstrumentationType.BREAKPOINT);
    state.recordHit();
    expect(state.hitInLastPeriod).toBe(true);
    state.resetPeriodFlag();
    expect(state.hitInLastPeriod).toBe(false);
  });

  it('should rate limit captures', function () {
    // Rate limiter defaults to 5/sec
    const state = new InstrumentationState('hash1', 100, null, InstrumentationType.BREAKPOINT, 2);
    // All calls within the same millisecond window
    expect(state.recordHit()).toBe(true); // 1
    expect(state.recordHit()).toBe(true); // 2
    expect(state.recordHit()).toBe(false); // rate limited (but hitCount still incremented to 3)
    expect(state.hitCount).toBe(3);
  });
});
