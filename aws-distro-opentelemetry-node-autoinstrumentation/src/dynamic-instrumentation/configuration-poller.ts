// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { DynamicInstrumentationClient } from './client';
import { DynamicInstrumentationConfig } from './config';
import { InstrumentationType } from './model/types';
import { InstrumentationConfiguration, parseInstrumentationConfiguration } from './model/instrumentation-configuration';
import { ListConfigurationsResponse } from './model/api-response';

const MAX_BACKOFF_ATTEMPTS = 3;
const BACKOFF_DELAYS_SECONDS = [10, 30, 120];
const DEGRADED_POLL_INTERVAL_SECONDS = 300; // 5 minutes — used when API endpoint is unreachable

const STALENESS_THRESHOLDS_SECONDS: Record<string, number> = {
  [InstrumentationType.PROBE]: 30 * 60,
  [InstrumentationType.BREAKPOINT]: 5 * 60,
};

export interface PollerCallbacks {
  onProbeBreakpointConfigs: (configs: InstrumentationConfiguration[]) => void;
}

/**
 * Polls the API for PROBE and BREAKPOINT configurations.
 *
 * Independent polling loops, each with:
 * - Configurable interval with 0-25% jitter
 * - Exponential backoff for initial fetch [10s, 30s, 120s]
 * - Degraded polling mode (every 300s) after 3 failed initial attempts until API endpoint is available
 * - Staleness detection (PROBE 30min, BREAKPOINT 5min)
 * - SyncedAt incremental sync
 * - Changed flag optimization (skip processing if unchanged)
 */
export class ConfigurationPoller {
  private readonly client: DynamicInstrumentationClient;
  private readonly config: DynamicInstrumentationConfig;
  private readonly callbacks: PollerCallbacks;

  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private breakpointTimer: ReturnType<typeof setTimeout> | null = null;

  private cachedProbeConfigs: InstrumentationConfiguration[] = [];
  private cachedBreakpointConfigs: InstrumentationConfiguration[] = [];

  private started: boolean = false;

  constructor(client: DynamicInstrumentationClient, config: DynamicInstrumentationConfig, callbacks: PollerCallbacks) {
    this.client = client;
    this.config = config;
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    diag.info('DI: Starting configuration pollers');

    // PROBE poller disabled — JS only supports line-level instrumentation (BREAKPOINT).
    // Method-level (PROBE) requires function entry/exit hooks not available via V8 Inspector.
    // Code preserved for when function-level instrumentation is added.

    // Start BREAKPOINT poller
    this.startPollerLoop(InstrumentationType.BREAKPOINT, this.config.breakpointPollIntervalSeconds, configs => {
      this.cachedBreakpointConfigs = configs;
      this.applyMergedConfigs();
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.breakpointTimer) {
      clearTimeout(this.breakpointTimer);
      this.breakpointTimer = null;
    }

    diag.info('DI: Configuration pollers stopped');
  }

  private applyMergedConfigs(): void {
    const allConfigs = [...this.cachedProbeConfigs, ...this.cachedBreakpointConfigs];
    this.callbacks.onProbeBreakpointConfigs(allConfigs);
  }

  private startPollerLoop(
    type: InstrumentationType,
    intervalSeconds: number,
    onConfigs: (configs: InstrumentationConfiguration[]) => void
  ): void {
    let isFirstFetch = true;
    let attempt = 0;
    let degradedLogged = false;
    let lastSyncTime: number | undefined;
    let lastSuccessTime: number | null = null;

    const poll = async () => {
      if (!this.started) return;

      try {
        const response = await this.client.fetchConfigurations(
          this.config.serviceName,
          this.config.environment,
          type,
          lastSyncTime
        );

        // Update sync time
        if (response.SyncedAt !== null) {
          lastSyncTime = response.SyncedAt;
        }

        // Update success time on any successful fetch (not just when Changed)
        lastSuccessTime = Date.now();

        if (response.Changed) {
          const configs = this.parseProbeBreakpointConfigs(response);
          diag.debug(`DI: [${type}] Fetched ${configs.length} configurations`);
          onConfigs(configs);
        } else {
          diag.debug(`DI: [${type}] No changes since last sync`);
        }

        if (isFirstFetch) {
          diag.info(`DI: [${type}] Initial configuration fetch successful`);
          isFirstFetch = false;
          attempt = 0;
          degradedLogged = false;
        }
      } catch (error) {
        if (isFirstFetch) {
          // Cap so `attempt` keeps meaning "number of initial backoff attempts"
          // rather than growing unbounded once we are in degraded mode.
          if (attempt < MAX_BACKOFF_ATTEMPTS) attempt++;

          if (attempt >= MAX_BACKOFF_ATTEMPTS) {
            // Log once when entering degraded mode
            if (!degradedLogged) {
              degradedLogged = true;
              diag.warn(
                `DI: [${type}] Dynamic Instrumentation API endpoint unreachable after ${MAX_BACKOFF_ATTEMPTS} attempts. ` +
                  `Entering degraded polling mode (every ${DEGRADED_POLL_INTERVAL_SECONDS}s). ` +
                  'Will resume normal polling when the endpoint becomes available. ' +
                  'Verify the API endpoint (OTEL_AWS_DYNAMIC_INSTRUMENTATION_API_URL) is reachable ' +
                  'or set OTEL_AWS_DYNAMIC_INSTRUMENTATION_ENABLED=false to disable.'
              );
            }

            // Degraded mode: poll slowly until API endpoint becomes available
            const jitter = DEGRADED_POLL_INTERVAL_SECONDS * Math.random() * 0.25;
            const delayMs = (DEGRADED_POLL_INTERVAL_SECONDS + jitter) * 1000;
            this.scheduleTimer(type, poll, delayMs);
            return;
          }

          diag.warn(`DI: [${type}] Initial fetch attempt ${attempt}/${MAX_BACKOFF_ATTEMPTS} failed: ${error}`);

          // Backoff delay with jitter
          const backoffDelay = BACKOFF_DELAYS_SECONDS[Math.min(attempt - 1, BACKOFF_DELAYS_SECONDS.length - 1)];
          const jitter = backoffDelay * Math.random() * 0.25;
          const delayMs = (backoffDelay + jitter) * 1000;
          this.scheduleTimer(type, poll, delayMs);
          return;
        }

        diag.warn(`DI: [${type}] Fetch failed, continuing with cached configuration: ${error}`);
        this.checkStaleness(type, lastSuccessTime);
      }

      // Schedule next poll with jitter
      const jitter = intervalSeconds * Math.random() * 0.25;
      const delayMs = (intervalSeconds + jitter) * 1000;
      this.scheduleTimer(type, poll, delayMs);
    };

    // Start first poll
    void poll();
  }

  private parseProbeBreakpointConfigs(response: ListConfigurationsResponse): InstrumentationConfiguration[] {
    const configs: InstrumentationConfiguration[] = [];
    for (const item of response.LatestConfigurations ?? []) {
      try {
        const config = parseInstrumentationConfiguration(item);
        if (config) {
          if (this.matchesAttributeFilters(config.attributeFilters)) {
            configs.push(config);
          }
        }
      } catch (error) {
        diag.warn('DI: Failed to parse config item, skipping', error);
      }
    }
    return configs;
  }

  private matchesAttributeFilters(filters: Array<Record<string, string>>): boolean {
    if (!filters || filters.length === 0) return true;

    // OR across filter objects — any one matching filter is sufficient
    for (const filter of filters) {
      let allMatch = true;
      // AND within a single filter object — all key-value pairs must match
      for (const [key, expectedValue] of Object.entries(filter)) {
        const actualValue = this.getResourceAttribute(key);
        if (actualValue !== expectedValue) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return true;
    }
    return false;
  }

  private getResourceAttribute(key: string): string | undefined {
    // Check common attributes
    if (key === 'service.name') return this.config.serviceName;
    if (key === 'deployment.environment.name' || key === 'deployment.environment') {
      return this.config.environment;
    }

    // Check OTEL_RESOURCE_ATTRIBUTES
    const envResources = process.env.OTEL_RESOURCE_ATTRIBUTES ?? '';
    for (const pair of envResources.split(',')) {
      if (pair.includes('=')) {
        const [k, ...rest] = pair.split('=');
        if (k.trim() === key) return rest.join('=').trim();
      }
    }
    return undefined;
  }

  private checkStaleness(type: string, lastSuccessTime: number | null): void {
    if (lastSuccessTime === null) return;
    const threshold = STALENESS_THRESHOLDS_SECONDS[type];
    if (!threshold) return;
    const ageSeconds = (Date.now() - lastSuccessTime) / 1000;
    if (ageSeconds > threshold) {
      diag.warn(
        `DI: [${type}] Configuration is stale (${Math.round(
          ageSeconds
        )}s since last successful sync, threshold: ${threshold}s)`
      );
    }
  }

  private scheduleTimer(type: InstrumentationType, fn: () => void, delayMs: number): void {
    const timer = setTimeout(fn, delayMs);
    if (timer.unref) timer.unref();

    if (type === InstrumentationType.PROBE) this.probeTimer = timer;
    else if (type === InstrumentationType.BREAKPOINT) this.breakpointTimer = timer;
  }
}
