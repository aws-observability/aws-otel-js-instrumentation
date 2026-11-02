// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { BaseCollector } from '../../../src/serviceevents/collectors/base-collector';

// Concrete subclass for testing
class TestCollector extends BaseCollector {
  collectCallCount: number = 0;
  shouldThrow: boolean = false;

  constructor(flushIntervalMs: number = 60000) {
    super(flushIntervalMs, 'TestCollector');
  }

  collect(): void {
    this.collectCallCount++;
    if (this.shouldThrow) {
      throw new Error('test collection error');
    }
  }
}

describe('BaseCollector', function () {
  let collector: TestCollector;

  afterEach(function () {
    try {
      collector.stop();
    } catch {
      // Ignore
    }
  });

  describe('start()', function () {
    it('should set running state to true', function () {
      collector = new TestCollector();
      expect(collector.isRunning()).toBe(false);
      collector.start();
      expect(collector.isRunning()).toBe(true);
    });

    it('should warn and skip when already running', function () {
      collector = new TestCollector();
      collector.start();
      // Second start should not throw
      collector.start();
      expect(collector.isRunning()).toBe(true);
    });
  });

  describe('stop()', function () {
    it('should set running state to false', function () {
      collector = new TestCollector();
      collector.start();
      collector.stop();
      expect(collector.isRunning()).toBe(false);
    });

    it('should perform final collection on stop', function () {
      collector = new TestCollector();
      collector.start();
      const countBefore = collector.collectCallCount;
      collector.stop();
      // Final collection should have been called
      expect(collector.collectCallCount).toBe(countBefore + 1);
    });

    it('should handle stop when not running', function () {
      collector = new TestCollector();
      // Should not throw
      collector.stop();
      expect(collector.isRunning()).toBe(false);
    });

    it('should handle error in final collection', function () {
      collector = new TestCollector();
      collector.start();
      collector.shouldThrow = true;
      // Should not throw even if collect() throws
      collector.stop();
      expect(collector.isRunning()).toBe(false);
    });
  });

  describe('isRunning()', function () {
    it('should reflect lifecycle state', function () {
      collector = new TestCollector();
      expect(collector.isRunning()).toBe(false);
      collector.start();
      expect(collector.isRunning()).toBe(true);
      collector.stop();
      expect(collector.isRunning()).toBe(false);
    });
  });

  describe('periodic collection via interval', function () {
    it('should call collect on interval', function (done: Mocha.Done) {
      // Use a very short interval for testing
      collector = new TestCollector(50);
      collector.start();
      setTimeout(() => {
        // At least one interval-triggered collection should have happened
        expect(collector.collectCallCount).toBeGreaterThanOrEqual(1);
        collector.stop();
        done();
      }, 150);
    });
  });

  describe('setFlushIntervalMs()', function () {
    it('should clamp below minimum (1000ms)', function () {
      collector = new TestCollector(30000);
      collector.setFlushIntervalMs(500);
      // Access protected field via the public getter pattern in tests
      expect((collector as any).flushIntervalMs).toBe(1000);
    });

    it('should clamp above maximum (300000ms)', function () {
      collector = new TestCollector(30000);
      collector.setFlushIntervalMs(500000);
      expect((collector as any).flushIntervalMs).toBe(300000);
    });

    it('should accept valid value', function () {
      collector = new TestCollector(30000);
      collector.setFlushIntervalMs(15000);
      expect((collector as any).flushIntervalMs).toBe(15000);
    });

    it('should no-op when value unchanged', function () {
      collector = new TestCollector(30000);
      collector.start();
      const countBefore = collector.collectCallCount;
      collector.setFlushIntervalMs(30000);
      // Should not have triggered any additional collections
      expect(collector.collectCallCount).toBe(countBefore);
    });

    it('should restart timer when running', function (done: Mocha.Done) {
      collector = new TestCollector(60000); // Very long interval
      collector.start();
      expect(collector.collectCallCount).toBe(0);
      // Switch to a very short interval
      collector.setFlushIntervalMs(1000);
      setTimeout(() => {
        expect(collector.collectCallCount).toBeGreaterThanOrEqual(1);
        collector.stop();
        done();
      }, 1500);
    });

    it('should work when collector is not yet started', function () {
      collector = new TestCollector(30000);
      collector.setFlushIntervalMs(10000);
      expect((collector as any).flushIntervalMs).toBe(10000);
      expect(collector.isRunning()).toBe(false);
    });
  });
});
