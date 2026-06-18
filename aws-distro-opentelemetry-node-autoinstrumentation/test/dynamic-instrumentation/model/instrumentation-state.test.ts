// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
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

  it('should rate limit captures within a fixed window', function () {
    // Drive the rate limiter with an explicit timestamp so all three calls are
    // provably in the same 1-second window. Using recordHit() (real Date.now())
    // is flaky: if the calls straddle a 1-second boundary the window resets and
    // the third call is no longer rate-limited.
    const state = new InstrumentationState('hash1', 100, null, InstrumentationType.BREAKPOINT, 2);
    const nowMs = 1_000; // start of a fixed window
    expect(state.rateLimiter.tryAcquire(nowMs)).toBe(true); // 1
    expect(state.rateLimiter.tryAcquire(nowMs)).toBe(true); // 2
    expect(state.rateLimiter.tryAcquire(nowMs)).toBe(false); // rate limited (limit = 2)
  });

  it('should not count rate-limited hits toward maxHits', function () {
    // Throttled hits return false and must not consume the maxHits budget —
    // hitCount tracks allowed captures only (matches Java/Python SDK behavior).
    const state = new InstrumentationState('hash1', 100, null, InstrumentationType.BREAKPOINT);
    const tryAcquire = sinon.stub(state.rateLimiter, 'tryAcquire');

    tryAcquire.returns(false);
    expect(state.recordHit()).toBe(false);
    expect(state.recordHit()).toBe(false);
    expect(state.hitCount).toBe(0);
    expect(state.isDisabled).toBe(false);
    // The breakpoint is being hit even though captures are throttled
    expect(state.hitInLastPeriod).toBe(true);

    tryAcquire.returns(true);
    expect(state.recordHit()).toBe(true);
    expect(state.hitCount).toBe(1);

    tryAcquire.restore();
  });

  it('should allow exactly maxHits captures when throttled hits are interleaved', function () {
    const state = new InstrumentationState('hash1', 2, null, InstrumentationType.BREAKPOINT);
    const tryAcquire = sinon.stub(state.rateLimiter, 'tryAcquire');

    tryAcquire.returns(true);
    expect(state.recordHit()).toBe(true); // capture 1
    tryAcquire.returns(false);
    expect(state.recordHit()).toBe(false); // throttled — budget intact
    expect(state.recordHit()).toBe(false); // throttled — budget intact
    tryAcquire.returns(true);
    expect(state.recordHit()).toBe(true); // capture 2 — budget now exhausted
    expect(state.hitCount).toBe(2);
    expect(state.isDisabled).toBe(false);

    expect(state.recordHit()).toBe(false); // maxHits reached
    expect(state.isDisabled).toBe(true);
    expect(state.disableReason).toBe(DisableReason.MAX_HITS_REACHED);

    tryAcquire.restore();
  });

  it('should check maxHits before consuming a rate-limiter token', function () {
    const state = new InstrumentationState('hash1', 1, null, InstrumentationType.BREAKPOINT);
    const tryAcquire = sinon.stub(state.rateLimiter, 'tryAcquire').returns(true);

    expect(state.recordHit()).toBe(true); // capture 1 — exhausts maxHits=1
    expect(tryAcquire.callCount).toBe(1);

    expect(state.recordHit()).toBe(false); // disables via maxHits…
    expect(tryAcquire.callCount).toBe(1); // …without consuming a token

    tryAcquire.restore();
  });
});
