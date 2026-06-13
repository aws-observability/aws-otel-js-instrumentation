// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
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
});
