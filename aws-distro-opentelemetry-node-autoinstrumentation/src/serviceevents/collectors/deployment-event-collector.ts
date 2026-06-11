// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { BaseCollector } from './base-collector';
import { ServiceEventsOtlpEmitter } from '../exporter/otlp-emitter';

export class DeploymentEventCollector extends BaseCollector {
  private otlpEmitter: ServiceEventsOtlpEmitter | null;

  constructor(flushIntervalMs: number, otlpEmitter: ServiceEventsOtlpEmitter | null) {
    super(flushIntervalMs, 'DeploymentEventCollector');
    this.otlpEmitter = otlpEmitter;
  }

  override start(): void {
    if (this.otlpEmitter) {
      try {
        this.otlpEmitter.emitDeploymentEvent('startup');
        diag.info('Emitted DeploymentEvent (trigger=startup)');
      } catch (err) {
        diag.error(`Error in startup DeploymentEvent emit: ${err}`);
      }
    }
    super.start();
  }

  collect(): void {
    if (!this.otlpEmitter) return;
    const trigger = this.isRunning() ? 'periodic' : 'shutdown';
    try {
      this.otlpEmitter.emitDeploymentEvent(trigger);
      diag.info(`Emitted DeploymentEvent (trigger=${trigger})`);
    } catch (err) {
      diag.error(`Failed to emit DeploymentEvent: ${err}`);
    }
  }
}
