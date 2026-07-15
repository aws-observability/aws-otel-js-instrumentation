// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { InstrumentationRegistry } from '../../../src/dynamic-instrumentation/registry/instrumentation-registry';
import { InstrumentationConfiguration } from '../../../src/dynamic-instrumentation/model/instrumentation-configuration';
import { InstrumentationType } from '../../../src/dynamic-instrumentation/model/types';
import { CAPTURE_DEFAULTS } from '../../../src/dynamic-instrumentation/model/capture-configuration';

function makeTestConfig(overrides: Partial<InstrumentationConfiguration> = {}): InstrumentationConfiguration {
  return {
    codeUnit: '',
    className: '',
    methodName: 'testFunc',
    lineNumber: 10,
    filePath: 'test.js',
    captureConfig: CAPTURE_DEFAULTS as any,
    locationHash: 'hash123',
    instrumentationType: InstrumentationType.BREAKPOINT,
    expiresAt: null,
    maxHits: 100,
    attributeFilters: [],
    arn: '',
    createdAt: null,
    signalType: 'SNAPSHOT',
    ...overrides,
  };
}

describe('InstrumentationRegistry', function () {
  let registry: InstrumentationRegistry;

  beforeEach(function () {
    registry = new InstrumentationRegistry();
  });

  it('should register and retrieve a config', function () {
    const config = makeTestConfig();
    registry.register(config);
    expect(registry.size()).toBe(1);
    const entry = registry.get('test.js:testFunc:10');
    expect(entry).not.toBeUndefined();
    expect(entry!.config.locationHash).toBe('hash123');
  });

  it('should preserve state for unchanged config', function () {
    const config = makeTestConfig();
    registry.register(config);
    const entry1 = registry.get('test.js:testFunc:10')!;
    entry1.state.recordHit();
    expect(entry1.state.hitCount).toBe(1);

    // Re-register same locationHash — state should be preserved
    registry.register(config);
    const entry2 = registry.get('test.js:testFunc:10')!;
    expect(entry2.state.hitCount).toBe(1);
  });

  it('should create new state for changed config (different locationHash)', function () {
    registry.register(makeTestConfig({ locationHash: 'hash-v1' }));
    const entry1 = registry.get('test.js:testFunc:10')!;
    entry1.state.recordHit();

    registry.register(makeTestConfig({ locationHash: 'hash-v2' }));
    const entry2 = registry.get('test.js:testFunc:10')!;
    expect(entry2.state.hitCount).toBe(0); // fresh state
    expect(entry2.config.locationHash).toBe('hash-v2');
  });

  it('should unregister a config', function () {
    registry.register(makeTestConfig());
    expect(registry.size()).toBe(1);
    registry.unregister('test.js:testFunc:10');
    expect(registry.size()).toBe(0);
    expect(registry.get('test.js:testFunc:10')).toBeUndefined();
  });

  it('should find by locationHash', function () {
    registry.register(makeTestConfig({ locationHash: 'findme' }));
    const entry = registry.getByLocationHash('findme');
    expect(entry).not.toBeUndefined();
    expect(entry!.config.methodName).toBe('testFunc');
  });

  it('should return undefined for missing locationHash', function () {
    expect(registry.getByLocationHash('missing')).toBeUndefined();
  });

  it('should mark config as installed', function () {
    registry.register(makeTestConfig());
    const entry = registry.get('test.js:testFunc:10')!;
    expect(entry.state.installed).toBe(false);
    registry.markInstalled('test.js:testFunc:10');
    expect(entry.state.installed).toBe(true);
  });

  it('should compute diff — additions', function () {
    const newConfigs = [makeTestConfig({ locationHash: 'new1' })];
    const diff = registry.computeDiff(newConfigs);
    expect(diff.toAdd.length).toBe(1);
    expect(diff.toRemove.length).toBe(0);
    expect(diff.unchanged.length).toBe(0);
  });

  it('should compute diff — removals', function () {
    registry.register(makeTestConfig({ locationHash: 'old1' }));
    const diff = registry.computeDiff([]); // empty = remove all
    expect(diff.toAdd.length).toBe(0);
    expect(diff.toRemove.length).toBe(1);
  });

  it('should compute diff — unchanged', function () {
    registry.register(makeTestConfig({ locationHash: 'same' }));
    const diff = registry.computeDiff([makeTestConfig({ locationHash: 'same' })]);
    expect(diff.toAdd.length).toBe(0);
    expect(diff.toRemove.length).toBe(0);
    expect(diff.unchanged.length).toBe(1);
  });

  it('should compute diff — changed locationHash', function () {
    registry.register(makeTestConfig({ locationHash: 'v1' }));
    const diff = registry.computeDiff([makeTestConfig({ locationHash: 'v2' })]);
    expect(diff.toRemove.length).toBe(1); // remove old
    expect(diff.toAdd.length).toBe(1); // add new
  });

  it('should handle last-writer-wins for same key', function () {
    registry.register(makeTestConfig({ locationHash: 'first' }));
    registry.register(makeTestConfig({ locationHash: 'second' }));
    expect(registry.size()).toBe(1);
    const entry = registry.get('test.js:testFunc:10')!;
    expect(entry.config.locationHash).toBe('second');
  });

  it('should clear all entries', function () {
    registry.register(makeTestConfig({ methodName: 'a', locationHash: 'h1' }));
    registry.register(makeTestConfig({ methodName: 'b', locationHash: 'h2' }));
    registry.clear();
    expect(registry.size()).toBe(0);
  });

  it('should detect recreated config with same locationHash but different createdAt', function () {
    const config1 = makeTestConfig({ locationHash: 'hash1', createdAt: 1000 });
    registry.register(config1);

    const config2 = makeTestConfig({ locationHash: 'hash1', createdAt: 2000 });
    const diff = registry.computeDiff([config2]);

    expect(diff.toRemove.length).toBe(1);
    expect(diff.toAdd.length).toBe(1);
    expect(diff.unchanged.length).toBe(0);
    expect(diff.toRemove[0]).toBe('test.js:testFunc:10');
    expect(diff.toAdd[0].createdAt).toBe(2000);
  });

  it('should treat identical locationHash and createdAt as unchanged', function () {
    const config1 = makeTestConfig({ locationHash: 'hash1', createdAt: 1000 });
    registry.register(config1);

    const config2 = makeTestConfig({ locationHash: 'hash1', createdAt: 1000 });
    const diff = registry.computeDiff([config2]);

    expect(diff.toRemove.length).toBe(0);
    expect(diff.toAdd.length).toBe(0);
    expect(diff.unchanged.length).toBe(1);
    expect(diff.unchanged[0]).toBe('test.js:testFunc:10');
  });

  it('should reset state when createdAt changes', function () {
    const config1 = makeTestConfig({ locationHash: 'hash1', createdAt: 1000 });
    registry.register(config1);
    const entry1 = registry.get('test.js:testFunc:10')!;
    entry1.state.recordHit();
    entry1.state.recordHit();
    expect(entry1.state.hitCount).toBe(2);

    const config2 = makeTestConfig({ locationHash: 'hash1', createdAt: 2000 });
    registry.register(config2);
    const entry2 = registry.get('test.js:testFunc:10')!;
    expect(entry2.state.hitCount).toBe(0);
    expect(entry2.state.isDisabled).toBe(false);
  });
});
