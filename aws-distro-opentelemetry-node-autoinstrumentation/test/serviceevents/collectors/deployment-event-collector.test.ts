// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import { DeploymentEventCollector } from '../../../src/serviceevents/collectors/deployment-event-collector';

/**
 * Fake emitter capturing emitDeploymentEvent triggers and exposing a controllable whenReady().
 * Mirrors the real ServiceEventsOtlpEmitter contract used by the collector.
 */
class FakeEmitter {
  triggers: string[] = [];
  private resolveReady!: () => void;
  private readyPromise: Promise<void>;

  constructor(readyImmediately: boolean = false) {
    this.readyPromise = new Promise<void>(resolve => {
      this.resolveReady = resolve;
    });
    if (readyImmediately) this.resolveReady();
  }

  markReady(): void {
    this.resolveReady();
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  emitDeploymentEvent(trigger: string = 'periodic'): void {
    this.triggers.push(trigger);
  }
}

describe('DeploymentEventCollector', () => {
  it('defers the startup emit until the emitter is ready (does NOT emit synchronously)', async () => {
    const emitter = new FakeEmitter(/* readyImmediately */ false);
    const collector = new DeploymentEventCollector(86_400_000, emitter as any);

    collector.start();
    // Synchronous: nothing emitted yet because the emitter isn't ready (the original bug —
    // a synchronous startup emit here was dropped by ensureInitialized()'s readiness gate).
    assert.deepStrictEqual(emitter.triggers, []);

    emitter.markReady();
    await emitter.whenReady();
    // microtask flush for the .then() callback
    await Promise.resolve();

    assert.deepStrictEqual(emitter.triggers, ['startup']);
    collector.stop();
  });

  it('emits startup exactly once even if start() resolves after readiness was already set', async () => {
    const emitter = new FakeEmitter(/* readyImmediately */ true);
    const collector = new DeploymentEventCollector(86_400_000, emitter as any);

    collector.start();
    await emitter.whenReady();
    await Promise.resolve();

    assert.deepStrictEqual(emitter.triggers, ['startup']);
    collector.stop();
  });

  it('falls back to labeling the first collect "startup" if it runs before the deferred emit', () => {
    // Simulate a collect() firing before whenReady() resolved (e.g. immediate shutdown).
    const emitter = new FakeEmitter(/* readyImmediately */ false);
    const collector = new DeploymentEventCollector(86_400_000, emitter as any);

    // Do not call start() (so the deferred emit hasn't fired); invoke collect() directly.
    (collector as any).collect();
    assert.deepStrictEqual(emitter.triggers, ['startup']);
  });

  it('does not double-emit startup (deferred + fallback are mutually exclusive)', async () => {
    const emitter = new FakeEmitter(/* readyImmediately */ true);
    const collector = new DeploymentEventCollector(86_400_000, emitter as any);

    collector.start();
    await emitter.whenReady();
    await Promise.resolve();
    // A subsequent collect() must be 'periodic', not a second 'startup'.
    (collector as any).collect();

    assert.deepStrictEqual(emitter.triggers, ['startup', 'periodic']);
    collector.stop();
  });
});
