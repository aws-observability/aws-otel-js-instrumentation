// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { DynamicInstrumentationClient } from './client';
import { InstrumentationRegistry } from './registry/instrumentation-registry';
import { ConfigurationStatus, ErrorCause, MAX_CONFIGS_PER_STATUS_REPORT } from './model/types';
import { StatusEntry } from './model/api-response';

const DEFAULT_REPORT_INTERVAL_MS = 60_000;

/**
 * Reports configuration status to the control plane.
 *
 * Periodic reporting (every 60s) + immediate reporting on certain events.
 *
 * Status rules:
 * - READY: reported once when config applied and hitCount === 0
 * - ACTIVE: reported every period if hitCount > 0
 * - DISABLED: reported once on expiry or maxHits
 * - ERROR: reported once on instrumentation failure
 */
export class StatusReporter {
  private readonly client: DynamicInstrumentationClient;
  private readonly registry: InstrumentationRegistry;
  private readonly serviceName: string;
  private readonly environment: string;

  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private started: boolean = false;

  // Pending error reports (from instrumentation failures)
  private pendingErrors: StatusEntry[] = [];

  constructor(
    client: DynamicInstrumentationClient,
    registry: InstrumentationRegistry,
    serviceName: string,
    environment: string
  ) {
    this.client = client;
    this.registry = registry;
    this.serviceName = serviceName;
    this.environment = environment;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.reportTimer = setInterval(() => void this.report(), DEFAULT_REPORT_INTERVAL_MS);
    if (this.reportTimer.unref) {
      this.reportTimer.unref();
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }

    // Final report
    void this.report();
  }

  /**
   * Report an instrumentation error for a configuration.
   */
  reportError(instrumentationType: string, locationHash: string, errorCause: ErrorCause): void {
    this.pendingErrors.push({
      InstrumentationType: instrumentationType,
      SignalType: 'SNAPSHOT',
      LocationHash: locationHash,
      Status: ConfigurationStatus.ERROR,
      Time: Math.floor(Date.now() / 1000),
      ErrorCause: errorCause,
    });

    // Send immediately
    this.reportNow();
  }

  /**
   * Trigger an immediate status report (e.g., after applying configs).
   */
  reportNow(): void {
    void this.report();
  }

  private async report(): Promise<void> {
    try {
      const entries: StatusEntry[] = [];

      // Collect status from registry
      const allEntries = this.registry.getAll();
      for (const { config, state } of allEntries) {
        // Check expiry
        state.checkExpiry();

        const status = state.getStatus();

        // READY: report once, only for installed configs (V8 breakpoint confirmed)
        if (status === ConfigurationStatus.READY && state.installed && !state.readyReported) {
          entries.push(this.buildEntry(config.instrumentationType, config.signalType, config.locationHash, status));
          state.readyReported = true;
        }
        // ACTIVE: report every period if hit
        else if (status === ConfigurationStatus.ACTIVE && state.hitInLastPeriod) {
          entries.push(this.buildEntry(config.instrumentationType, config.signalType, config.locationHash, status));
          state.resetPeriodFlag();
        }
        // DISABLED: report once
        else if (status === ConfigurationStatus.DISABLED && !state.disabledReported) {
          entries.push(this.buildEntry(config.instrumentationType, config.signalType, config.locationHash, status));
          state.disabledReported = true;
        }
      }

      // Add pending error reports
      entries.push(...this.pendingErrors);
      this.pendingErrors = [];

      if (entries.length === 0) return;

      // Send in batches of MAX_CONFIGS_PER_STATUS_REPORT
      for (let i = 0; i < entries.length; i += MAX_CONFIGS_PER_STATUS_REPORT) {
        const batch = entries.slice(i, i + MAX_CONFIGS_PER_STATUS_REPORT);
        try {
          await this.client.reportStatus({
            Service: this.serviceName,
            Environment: this.environment,
            Configurations: batch,
          });
          diag.debug(`DI: Reported ${batch.length} status entries`);
        } catch (error) {
          diag.warn(`DI: Failed to report status: ${error}`);
        }
      }
    } catch (error) {
      diag.warn('DI: Error during status report', error);
    }
  }

  private buildEntry(
    instrumentationType: string,
    signalType: string,
    locationHash: string,
    status: ConfigurationStatus,
    errorCause?: ErrorCause
  ): StatusEntry {
    const entry: StatusEntry = {
      InstrumentationType: instrumentationType,
      SignalType: signalType,
      LocationHash: locationHash,
      Status: status,
      Time: Math.floor(Date.now() / 1000),
    };
    if (errorCause) {
      entry.ErrorCause = errorCause;
    }
    return entry;
  }
}
