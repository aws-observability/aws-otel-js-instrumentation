// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { BaseCollector } from './base-collector';
import { ServiceEventsOtlpEmitter } from '../exporter/otlp-emitter';

export class DeploymentEventCollector extends BaseCollector {
  private otlpEmitter: ServiceEventsOtlpEmitter | null;
  // Guarantees the startup DeploymentEvent is emitted exactly once. Mirrors Python's
  // `_first_collect` / Java's `firstCollect` flag.
  private startupEmitted: boolean = false;

  constructor(flushIntervalMs: number, otlpEmitter: ServiceEventsOtlpEmitter | null) {
    super(flushIntervalMs, 'DeploymentEventCollector');
    this.otlpEmitter = otlpEmitter;
  }

  override start(): void {
    super.start();
    if (this.otlpEmitter) {
      // Defer the startup emit until the emitter's async resource has settled. Emitting
      // synchronously here (as before) raced the emitter constructor's async-attribute
      // resolution: ensureInitialized() gates on asyncResourceReady and silently no-ops the
      // emit (there is NO pre-init buffer — the record is dropped, not queued), so the
      // startup DeploymentEvent never reached the backend. whenReady() always resolves
      // (the constructor races a 2s timeout), so this fires within ~2s of startup, well
      // before the first periodic tick. Both arms call emitStartupOnce so even an unexpected
      // rejection still emits; the guard makes it idempotent.
      this.otlpEmitter.whenReady().then(
        () => this.emitStartupOnce(),
        () => this.emitStartupOnce()
      );
    }
  }

  /** Emit the startup DeploymentEvent exactly once (idempotent). */
  private emitStartupOnce(): void {
    if (this.startupEmitted || !this.otlpEmitter) return;
    this.startupEmitted = true;
    try {
      this.otlpEmitter.emitDeploymentEvent('startup');
      diag.info('Emitted DeploymentEvent (trigger=startup)');
    } catch (err) {
      diag.error(`Error in startup DeploymentEvent emit: ${err}`);
    }
  }

  collect(): void {
    if (!this.otlpEmitter) return;
    // Fallback guarantee: if the deferred startup emit hasn't fired yet (e.g. a very fast
    // shutdown before whenReady() resolved), label this first-ever emit "startup" rather
    // than losing the marker — matching Python/Java's first-collect-is-startup semantics.
    if (!this.startupEmitted) {
      this.emitStartupOnce();
      return;
    }
    const trigger = this.isRunning() ? 'periodic' : 'shutdown';
    try {
      this.otlpEmitter.emitDeploymentEvent(trigger);
      diag.info(`Emitted DeploymentEvent (trigger=${trigger})`);
    } catch (err) {
      diag.error(`Failed to emit DeploymentEvent: ${err}`);
    }
  }
}
