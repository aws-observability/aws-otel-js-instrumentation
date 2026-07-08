// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { parentPort, workerData } from 'worker_threads';
import { diag } from '@opentelemetry/api';
import { DynamicInstrumentationConfig } from './config';
import { DynamicInstrumentationClient } from './client';
import { FileResolver } from './file-resolver';
import { SourceMapResolver } from './source-map-resolver';
import { InspectorSession } from './session';
import { BreakpointManager } from './breakpoint-manager';
import { InstrumentationRegistry } from './registry/instrumentation-registry';
import { SnapshotOtlpEmitter } from './snapshot-otlp-emitter';
import { SnapshotCollector } from './snapshot-collector';
import { ConfigurationPoller } from './configuration-poller';
import { StatusReporter } from './status-reporter';
import { InstrumentationConfiguration } from './model/instrumentation-configuration';

/**
 * DI Worker thread entry point.
 *
 * Runs the V8 Inspector session, configuration polling, breakpoint management,
 * snapshot collection, and status reporting in a dedicated worker thread.
 *
 * Communicates with the main thread via parentPort messages:
 * - Sends: { type: 'ready' }, { type: 'error', error }
 * - Receives: { type: 'shutdown' }
 */

const config = workerData as DynamicInstrumentationConfig;

// Components are constructed inside initialize() (not at module load) so that a
// constructor throw is caught and reported to the parent thread via postMessage,
// rather than crashing the worker before the error handlers below are registered.
// Only the components needed by shutdown() are held at module scope.
let session: InspectorSession | undefined;
let emitter: SnapshotOtlpEmitter | undefined;
let breakpointManager: BreakpointManager | undefined;
let statusReporter: StatusReporter | undefined;
let poller: ConfigurationPoller | undefined;

let exiting: boolean = false;

/**
 * Construct and wire all components, then connect the inspector and start polling.
 * Any failure (including a component constructor throwing) is reported to the parent.
 */
async function initialize(): Promise<void> {
  try {
    const client = new DynamicInstrumentationClient(config.apiUrl, undefined, config.namespace, config.environment);
    const sourceMapResolver = new SourceMapResolver();
    const fileResolver = new FileResolver();
    fileResolver.setSourceMapResolver(sourceMapResolver);
    session = new InspectorSession(fileResolver, sourceMapResolver);
    const registry = new InstrumentationRegistry();
    emitter = new SnapshotOtlpEmitter(config.logsEndpoint, config.serviceName, config.environment);
    breakpointManager = new BreakpointManager(session, fileResolver, sourceMapResolver);
    const snapshotCollector = new SnapshotCollector(session, breakpointManager, registry, emitter, config);
    statusReporter = new StatusReporter(client, registry, config.serviceName, config.environment);

    // Wire error reporting from breakpoint manager to status reporter
    breakpointManager.setErrorCallback((type, hash, cause) => {
      statusReporter!.reportError(type, hash, cause);
    });

    // Wire installed callback — marks config as installed in registry after V8 confirms
    breakpointManager.setInstalledCallback((registryKey: string) => {
      registry.markInstalled(registryKey);
    });

    // Wire paused events to snapshot collector (handlePaused is async)
    session.onPaused(params => {
      snapshotCollector.handlePaused(params).catch(err => {
        diag.error('DI: Unhandled error in handlePaused', err);
      });
    });

    // Configuration poller callbacks
    poller = new ConfigurationPoller(client, config, {
      onProbeBreakpointConfigs: async (configs: InstrumentationConfiguration[]) => {
        try {
          const diff = registry.computeDiff(configs);

          // Remove old configs and breakpoints
          for (const key of diff.toRemove) {
            await breakpointManager!.removeBreakpoint(key);
            registry.unregister(key);
          }

          // Register and add new configs/breakpoints
          for (const newConfig of diff.toAdd) {
            registry.register(newConfig);
            await breakpointManager!.addBreakpoint(newConfig);
          }

          diag.debug(
            `DI: Applied config diff: +${diff.toAdd.length} -${diff.toRemove.length} =${diff.unchanged.length}`
          );

          // Report status — only installed configs will report READY
          statusReporter!.reportNow();
        } catch (error) {
          diag.error('DI: Error applying configuration diff', error);
        }
      },
    });

    // Await connect() — ensures Debugger.enable completes and scriptParsed events
    // are processed so FileResolver and SourceMapResolver are populated before polling.
    await session.connect();
    statusReporter.start();
    poller.start();

    // Notify main thread we're ready
    if (parentPort) {
      parentPort.postMessage({ type: 'ready' });
    }

    diag.info('DI: Worker thread initialized successfully');
  } catch (error) {
    diag.error('DI: Worker thread initialization failed', error);
    if (parentPort) {
      parentPort.postMessage({ type: 'error', error: String(error) });
    }
  }
}

async function shutdown(): Promise<void> {
  try {
    poller?.stop();
    statusReporter?.stop();
    await breakpointManager?.removeAll();
    session?.disconnect();
    await emitter?.shutdown();
    diag.info('DI: Worker thread shutdown complete');
  } catch (error) {
    diag.error('DI: Error during worker shutdown', error);
  }

  // Exit worker
  process.exit(0);
}

// Register error and shutdown handlers BEFORE constructing components, so a failure
// during initialize() is reported to the parent rather than crashing silently.

// Handle unexpected errors — exit worker to avoid running in corrupted state.
// The main thread detects worker exit via 'exit' event and logs the failure.
// Brief delay before exit allows parentPort.postMessage to flush.
process.on('uncaughtException', error => {
  if (exiting) return;
  exiting = true;
  diag.error('DI: Uncaught exception in worker, exiting', error);
  if (parentPort) {
    try {
      parentPort.postMessage({ type: 'error', error: String(error) });
    } catch {
      // postMessage may fail if worker is already shutting down
    }
  }
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', reason => {
  if (exiting) return;
  exiting = true;
  diag.error('DI: Unhandled rejection in worker, exiting', reason);
  if (parentPort) {
    try {
      parentPort.postMessage({ type: 'error', error: String(reason) });
    } catch {
      // postMessage may fail if worker is already shutting down
    }
  }
  setTimeout(() => process.exit(1), 100);
});

// Handle shutdown from main thread
if (parentPort) {
  parentPort.on('message', message => {
    if (message?.type === 'shutdown') {
      diag.info('DI: Worker thread shutting down');
      void shutdown();
    }
  });
}

void initialize();
