// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { diag } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { createDynamicInstrumentationConfig, DynamicInstrumentationConfig } from './config';

// Max time to wait for async resource detectors (EC2/ECS/EKS, etc.) to resolve
// before reading resource attributes for attribute-filter evaluation.
const RESOURCE_ATTRIBUTES_TIMEOUT_MS = 2000;

/**
 * Main thread entry point for Dynamic Instrumentation.
 *
 * Singleton manager that:
 * - Checks env var toggle and Lambda detection
 * - Creates the DI config from env vars
 * - Spawns a worker thread that runs the V8 Inspector session, pollers, etc.
 * - Handles worker thread messages (ready, error)
 * - Provides shutdown() for graceful cleanup
 */
export class DynamicInstrumentationManager {
  private static instance: DynamicInstrumentationManager | null = null;

  private worker: Worker | null = null;
  private config: DynamicInstrumentationConfig | null = null;
  private initialized: boolean = false;
  private shutdownTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): DynamicInstrumentationManager {
    if (!DynamicInstrumentationManager.instance) {
      DynamicInstrumentationManager.instance = new DynamicInstrumentationManager();
    }
    return DynamicInstrumentationManager.instance;
  }

  /**
   * Initialize the DI feature. Called from register.ts after a deferred timeout.
   *
   * @param resource the configured OTel SDK Resource, used to evaluate
   *   AttributeFilters against the application's real resource attributes.
   */
  async initialize(resource?: Resource): Promise<void> {
    if (this.initialized) {
      diag.debug('DI: Already initialized');
      return;
    }

    try {
      this.config = createDynamicInstrumentationConfig();

      if (!this.config.enabled) {
        diag.info('DI: Dynamic Instrumentation is disabled');
        return;
      }

      // Skip in Lambda — no CloudWatch Agent available
      if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
        diag.debug('DI: Skipping initialization in Lambda environment');
        return;
      }

      if (!this.config.serviceName || this.config.serviceName === 'unknown_service') {
        diag.warn(
          'DI: Service name not configured. Set OTEL_SERVICE_NAME or service.name in OTEL_RESOURCE_ATTRIBUTES.'
        );
      }

      this.config.resourceAttributes = await resolveResourceAttributes(resource);

      this.spawnWorker();
      this.initialized = true;

      diag.info('DI: Dynamic Instrumentation initialized');
    } catch (error) {
      diag.error('DI: Failed to initialize Dynamic Instrumentation', error);
    }
  }

  /**
   * Shutdown the DI feature gracefully.
   */
  shutdown(): void {
    if (!this.initialized) return;

    diag.info('DI: Shutting down Dynamic Instrumentation');

    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'shutdown' });
        // Give worker 5 seconds to shut down gracefully.
        // The 'exit' handler clears this timer when the worker exits before the deadline.
        this.shutdownTimer = setTimeout(() => {
          this.shutdownTimer = null;
          if (this.worker) {
            void this.worker.terminate();
            this.worker = null;
          }
        }, 5000);
        this.shutdownTimer.unref();
      } catch (error) {
        diag.debug('DI: Error sending shutdown to worker', error);
        try {
          void this.worker?.terminate();
        } catch {
          // Ignore
        }
        this.worker = null;
      }
    }

    this.initialized = false;
  }

  private spawnWorker(): void {
    const workerPath = path.join(__dirname, 'worker.js');

    if (!fs.existsSync(workerPath)) {
      diag.debug(`DI: Worker file not found at ${workerPath}, skipping`);
      return;
    }

    this.worker = new Worker(workerPath, {
      workerData: this.config,
    });

    // Allow the parent process to exit even if this worker is still running.
    // Prevents worker crashes from propagating exit codes to the parent.
    this.worker.unref();

    this.worker.on('message', message => {
      if (!message || typeof message !== 'object') return;

      switch (message.type) {
        case 'ready':
          diag.info('DI: Worker thread ready');
          break;

        case 'error':
          diag.error(`DI: Worker thread error: ${message.error}`);
          break;

        default:
          diag.debug(`DI: Unknown worker message type: ${message.type}`);
      }
    });

    this.worker.on('error', error => {
      diag.error('DI: Worker thread error', error);
    });

    this.worker.on('exit', code => {
      if (code !== 0) {
        diag.warn(`DI: Worker thread exited with code ${code}`);
      }
      if (this.shutdownTimer) {
        clearTimeout(this.shutdownTimer);
        this.shutdownTimer = null;
      }
      this.worker = null;
    });
  }
}

/**
 * Resolve the SDK Resource into a flat string-keyed map for attribute-filter
 * evaluation in the worker.
 *
 * Best-effort awaits async resource detectors (EC2/ECS/EKS, etc.) up to a
 * timeout so detector-contributed attributes are present. Non-string attribute
 * values are stringified, since filter comparison is exact string equality.
 * Never throws — returns an empty map on any failure, so DI initialization (and
 * the user's application) is never blocked by resource detection.
 */
export async function resolveResourceAttributes(resource?: Resource): Promise<Record<string, string>> {
  if (!resource) return {};

  try {
    if (resource.asyncAttributesPending && resource.waitForAsyncAttributes) {
      await Promise.race([
        resource.waitForAsyncAttributes(),
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, RESOURCE_ATTRIBUTES_TIMEOUT_MS);
          // Don't keep the event loop alive solely for this timeout.
          if (timer.unref) timer.unref();
        }),
      ]);
    }

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(resource.attributes)) {
      if (value === null || value === undefined) continue;
      result[key] = typeof value === 'string' ? value : String(value);
    }
    return result;
  } catch (error) {
    diag.warn('DI: Failed to resolve resource attributes for filtering', error);
    return {};
  }
}

// Re-export key types for integration
export { DynamicInstrumentationConfig, createDynamicInstrumentationConfig } from './config';
