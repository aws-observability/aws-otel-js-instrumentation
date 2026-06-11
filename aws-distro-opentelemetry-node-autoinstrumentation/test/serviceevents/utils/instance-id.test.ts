// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as os from 'os';
import { getInstanceId, clearInstanceIdCache } from '../../../src/serviceevents/utils/instance-id';

describe('InstanceId', function () {
  // Save and restore env vars
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(function () {
    savedEnv.INSTANCE_ID = process.env.INSTANCE_ID;
    savedEnv.HOSTNAME = process.env.HOSTNAME;
    delete process.env.INSTANCE_ID;
    delete process.env.HOSTNAME;
    clearInstanceIdCache();
  });

  afterEach(function () {
    if (savedEnv.INSTANCE_ID !== undefined) {
      process.env.INSTANCE_ID = savedEnv.INSTANCE_ID;
    } else {
      delete process.env.INSTANCE_ID;
    }
    if (savedEnv.HOSTNAME !== undefined) {
      process.env.HOSTNAME = savedEnv.HOSTNAME;
    } else {
      delete process.env.HOSTNAME;
    }
    clearInstanceIdCache();
  });

  it('should use INSTANCE_ID env var when set', function () {
    process.env.INSTANCE_ID = 'my-instance-123';
    const id = getInstanceId();
    expect(id).toBe('my-instance-123');
  });

  it('should use HOSTNAME env var as fallback', function () {
    process.env.HOSTNAME = 'my-hostname';
    const id = getInstanceId();
    expect(id).toBe('my-hostname');
  });

  it('should prefer INSTANCE_ID over HOSTNAME', function () {
    process.env.INSTANCE_ID = 'instance-id';
    process.env.HOSTNAME = 'hostname';
    const id = getInstanceId();
    expect(id).toBe('instance-id');
  });

  it('should fallback to os.hostname()', function () {
    const id = getInstanceId();
    expect(id).toBe(os.hostname());
  });

  it('should cache the result', function () {
    process.env.INSTANCE_ID = 'cached-id';
    const id1 = getInstanceId();
    // Change env var — should still return cached value
    process.env.INSTANCE_ID = 'different-id';
    const id2 = getInstanceId();
    expect(id1).toBe(id2);
    expect(id2).toBe('cached-id');
  });

  it('should return fresh value after clearing cache', function () {
    process.env.INSTANCE_ID = 'first-id';
    const id1 = getInstanceId();
    expect(id1).toBe('first-id');

    clearInstanceIdCache();
    process.env.INSTANCE_ID = 'second-id';
    const id2 = getInstanceId();
    expect(id2).toBe('second-id');
  });

  it('should return a non-empty string', function () {
    const id = getInstanceId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});
