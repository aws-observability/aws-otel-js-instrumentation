// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import { Resource } from '@opentelemetry/resources';
import { resolveResourceAttributes } from '../../src/dynamic-instrumentation';

/**
 * Build a minimal object that satisfies the OTel `Resource` shape used by
 * resolveResourceAttributes (attributes, asyncAttributesPending,
 * waitForAsyncAttributes). The rest of the interface is unused here.
 */
function fakeResource(opts: {
  attributes: Record<string, unknown>;
  asyncPending?: boolean;
  waitForAsyncAttributes?: () => Promise<void>;
}): Resource {
  return {
    attributes: opts.attributes,
    asyncAttributesPending: opts.asyncPending ?? false,
    waitForAsyncAttributes: opts.waitForAsyncAttributes,
  } as unknown as Resource;
}

describe('resolveResourceAttributes', function () {
  it('returns an empty map when no resource is provided', async function () {
    expect(await resolveResourceAttributes(undefined)).toEqual({});
  });

  it('copies string attributes verbatim', async function () {
    const result = await resolveResourceAttributes(
      fakeResource({
        attributes: { 'service.name': 'order-service', 'cloud.region': 'us-west-2' },
      })
    );
    expect(result).toEqual({ 'service.name': 'order-service', 'cloud.region': 'us-west-2' });
  });

  it('stringifies non-string attribute values', async function () {
    const result = await resolveResourceAttributes(
      fakeResource({
        attributes: { 'process.pid': 1234, 'service.enabled': true },
      })
    );
    expect(result).toEqual({ 'process.pid': '1234', 'service.enabled': 'true' });
  });

  it('skips null and undefined attribute values', async function () {
    const result = await resolveResourceAttributes(
      fakeResource({
        attributes: { 'a.present': 'yes', 'a.null': null, 'a.undefined': undefined },
      })
    );
    expect(result).toEqual({ 'a.present': 'yes' });
  });

  it('awaits async attributes when pending', async function () {
    let resolved = false;
    const result = await resolveResourceAttributes(
      fakeResource({
        attributes: { 'cloud.region': 'eu-central-1' },
        asyncPending: true,
        waitForAsyncAttributes: async () => {
          resolved = true;
        },
      })
    );
    expect(resolved).toBe(true);
    expect(result).toEqual({ 'cloud.region': 'eu-central-1' });
  });

  it('does not await when async attributes are not pending', async function () {
    let called = false;
    await resolveResourceAttributes(
      fakeResource({
        attributes: { 'service.name': 's' },
        asyncPending: false,
        waitForAsyncAttributes: async () => {
          called = true;
        },
      })
    );
    expect(called).toBe(false);
  });

  it('returns an empty map (never throws) when attribute access fails', async function () {
    const bad = {
      asyncAttributesPending: false,
      get attributes(): Record<string, unknown> {
        throw new Error('boom');
      },
    } as unknown as Resource;
    expect(await resolveResourceAttributes(bad)).toEqual({});
  });

  it('proceeds with current attributes when async detectors exceed the timeout', async function () {
    const clock = sinon.useFakeTimers();
    try {
      // waitForAsyncAttributes never settles within the timeout window.
      const resource = fakeResource({
        attributes: { 'service.name': 'partial' },
        asyncPending: true,
        waitForAsyncAttributes: () => new Promise<void>(() => undefined),
      });

      const promise = resolveResourceAttributes(resource);
      // Advance past the 2s timeout so the race resolves via the timer.
      await clock.tickAsync(2000);

      expect(await promise).toEqual({ 'service.name': 'partial' });
    } finally {
      clock.restore();
    }
  });

  it('swallows a detector rejection and still returns current attributes', async function () {
    // The detector rejects rather than resolving. The internal .catch on the wait
    // promise must consume the rejection so it neither throws out of the resolver nor
    // escapes as an unhandledRejection; the resolver returns whatever attributes exist.
    const resource = fakeResource({
      attributes: { 'service.name': 'partial' },
      asyncPending: true,
      waitForAsyncAttributes: () => Promise.reject(new Error('detector failed')),
    });

    const result = await resolveResourceAttributes(resource);
    expect(result).toEqual({ 'service.name': 'partial' });
  });

  it('proceeds at the timeout even if the detector rejects later, without leaking', async function () {
    // A detector that rejects only AFTER the timeout has won the race. Asserts the
    // resolver returns at the timeout AND that a late rejection is swallowed by the
    // internal .catch (a tracked unhandledRejection listener would otherwise fire).
    const clock = sinon.useFakeTimers();
    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const resource = fakeResource({
        attributes: { 'service.name': 'partial' },
        asyncPending: true,
        waitForAsyncAttributes: () =>
          new Promise<void>((_resolve, reject) => {
            const t = setTimeout(() => reject(new Error('detector failed late')), 5000);
            if (t.unref) t.unref();
          }),
      });

      const promise = resolveResourceAttributes(resource);
      await clock.tickAsync(2000); // timeout wins the race
      expect(await promise).toEqual({ 'service.name': 'partial' });

      await clock.tickAsync(5000); // fire the late rejection
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      clock.restore();
    }

    expect(rejections).toEqual([]);
  });
});
