// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Base collector class for periodic telemetry collection.
 * Uses setInterval() with unref() so the timer doesn't keep the process alive.
 */

import { diag } from '@opentelemetry/api';

export abstract class BaseCollector {
  protected flushIntervalMs: number;
  protected name: string;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running: boolean = false;

  constructor(flushIntervalMs: number, name: string) {
    this.flushIntervalMs = flushIntervalMs;
    this.name = name;
  }

  /** Start the periodic collection. */
  start(): void {
    if (this._running) {
      diag.warn(`${this.name} already running`);
      return;
    }

    diag.info(`Started ${this.name} (interval: ${this.flushIntervalMs}ms)`);
    this._running = true;

    this._timer = setInterval(() => {
      try {
        this.collect();
      } catch (err) {
        diag.error(`Error in ${this.name} collection: ${err}`);
      }
    }, this.flushIntervalMs);

    // Allow process to exit even if timer is still running (like daemon thread)
    this._timer.unref();
  }

  /** Stop the periodic collection. */
  stop(): void {
    if (!this._running) {
      return;
    }

    diag.info(`Stopping ${this.name}`);
    this._running = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    // Final collection on shutdown
    try {
      diag.debug(`${this.name} performing final collection`);
      this.collect();
    } catch (err) {
      diag.error(`Error in ${this.name} final collection: ${err}`);
    }
  }

  /** Dynamically update the flush interval. Takes effect immediately if running. */
  setFlushIntervalMs(newInterval: number): void {
    const MIN = 1000;
    const MAX = 300000;

    if (newInterval < MIN) {
      newInterval = MIN;
    } else if (newInterval > MAX) {
      newInterval = MAX;
    }

    if (newInterval === this.flushIntervalMs) {
      return;
    }

    this.flushIntervalMs = newInterval;

    if (this._running && this._timer) {
      clearInterval(this._timer);
      this._timer = setInterval(() => {
        try {
          this.collect();
        } catch (err) {
          diag.error(`Error in ${this.name} collection: ${err}`);
        }
      }, this.flushIntervalMs);
      this._timer.unref();
    }
  }

  /** Whether the collector is currently running. */
  isRunning(): boolean {
    return this._running;
  }

  /**
   * Collect and export telemetry data.
   * Called periodically by the interval timer. Subclasses must implement.
   */
  abstract collect(): void;
}
