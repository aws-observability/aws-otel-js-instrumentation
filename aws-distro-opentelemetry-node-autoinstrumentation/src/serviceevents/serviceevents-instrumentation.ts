// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Main entry point for ServiceEvents instrumentation.
 *
 * Manages the lifecycle of AST hooks, monitor state, collectors,
 * OTLP emitter, and framework instrumentations for deep observability
 * of Node.js applications.
 */

import { diag } from '@opentelemetry/api';
import { ServiceEventsConfig, getLatencyThresholdPatterns } from './config';
import {
  ServiceEventsMonitorState,
  setSamplingMode,
  setSamplingThresholds,
  setDetachThreshold,
  registerMonitorGlobals,
} from './serviceevents-monitor';
import {
  installAstHooks,
  uninstallAstHooks,
  installEsmHooks,
  registerFunctionRegistryGlobal,
} from './ast-transformation';
import { ServiceEventsOtlpEmitter } from './exporter/otlp-emitter';
import { FunctionCallCollector } from './collectors/function-call-collector';
import { EndpointMetricCollector } from './collectors/endpoint-collector';
import { IncidentSnapshotCollector } from './collectors/incident-snapshot-collector';
import { BaseCollector } from './collectors/base-collector';
import { installExpressHooks, installGlobalHttpPatches } from './instrumentation/express-instrumentation';
import { installFastifyHooks } from './instrumentation/fastify-instrumentation';
import { installKoaHooks } from './instrumentation/koa-instrumentation';
import { installNextJsHooks } from './instrumentation/nextjs-instrumentation';
import { DeploymentEventCollector } from './collectors/deployment-event-collector';
import { ProfilerCollector } from './profiler/profiler-collector';
import { SampleRing } from './profiler/sample-ring';
import { getCompletedRequests } from './profiler/request-tracker';
import { isRunningInLambda } from './profiler/lambda-guard';

// Module-level singleton instance
let _serviceeventsInstance: ServiceEventsInstrumentation | null = null;

export function getServiceEventsInstrumentation(config?: ServiceEventsConfig): ServiceEventsInstrumentation | null {
  if (_serviceeventsInstance !== null) {
    if (config !== undefined) {
      diag.debug(
        `ServiceEventsInstrumentation singleton already exists (service=${_serviceeventsInstance.config.serviceName}), ignoring new config`
      );
    }
    return _serviceeventsInstance;
  }

  if (config === undefined) {
    diag.debug('No ServiceEventsInstrumentation instance exists and no config provided');
    return null;
  }

  _serviceeventsInstance = new ServiceEventsInstrumentation(config);
  return _serviceeventsInstance;
}

/** Reset singleton (for testing). */
export function resetServiceEventsInstrumentation(): void {
  if (_serviceeventsInstance) {
    // Fire-and-forget in tests; shutdown() catches internally so this never rejects.
    void _serviceeventsInstance.shutdown();
  }
  _serviceeventsInstance = null;
}

export class ServiceEventsInstrumentation {
  readonly config: ServiceEventsConfig;
  private collectors: BaseCollector[] = [];
  private otlpEmitter: ServiceEventsOtlpEmitter | null = null;
  private _initialized: boolean = false;

  constructor(config: ServiceEventsConfig) {
    this.config = config;
  }

  initialize(): void {
    if (this._initialized) {
      diag.warn('ServiceEvents instrumentation already initialized, skipping');
      return;
    }

    if (!this.config.enabled) {
      diag.info('ServiceEvents instrumentation disabled via configuration');
      return;
    }

    try {
      diag.info('Initializing ServiceEvents instrumentation (OTLP-native)');

      ServiceEventsMonitorState.getInstance();

      setSamplingMode(this.config.samplingMode);
      setSamplingThresholds({
        tier1Threshold: this.config.sampleTier1Threshold,
        tier2Threshold: this.config.sampleTier2Threshold,
        tier2Rate: this.config.sampleTier2Rate,
        tier3Rate: this.config.sampleTier3Rate,
        hotEndpointCycles: this.config.hotEndpointCycles,
      });

      if (this.config.functionDetachThreshold > 0) {
        setDetachThreshold(this.config.functionDetachThreshold);
        diag.info(`Function detach threshold: ${this.config.functionDetachThreshold} calls/sec`);
      }

      // Initialize OTLP emitter — all signals flow here. AggregateProfile
      // records go through a standalone LoggerProvider with its own batching
      // and compression knobs (matches Python/Java SDK pattern). When
      // logsEndpoint points at the CloudWatch OTLP endpoint, the emitter
      // swaps in the SigV4-signed exporter and injects the configured
      // log-group/stream as headers.
      this.otlpEmitter = new ServiceEventsOtlpEmitter({
        serviceName: this.config.serviceName,
        environment: this.config.environment,
        sdkVersion: this.config.sdkVersion,
        outputFile: this.config.outputFile,
        profileExportCompression: this.config.profileExportCompression,
        profileExportBatchSize: this.config.profileExportBatchSize,
        profileExportScheduleDelayMs: this.config.profileExportScheduleDelayMs,
        profileExportMaxQueueSize: this.config.profileExportMaxQueueSize,
        profileExportTimeoutMs: this.config.profileExportTimeoutMs,
        logGroup: this.config.logGroup,
        logStream: this.config.logStream,
      });

      registerMonitorGlobals();
      registerFunctionRegistryGlobal();

      if (this.config.functionInstrumentEnabled) {
        // Wire OTel histogram directly into monitor state for real-time recording.
        // This bypasses the SEH pre-aggregation → reconstruction path, giving the
        // OTel ExponentialBucketHistogramAggregation raw duration values.
        //
        // Gated on a real OTLP endpoint (the emitter only creates the histogram
        // when not in `output_file` mode). In `output_file` mode the CloudWatch
        // metric file exporter only serializes Sum metrics — histogram data
        // would be silently dropped. The SEH → FunctionCallCollector path keeps
        // emitting `aws.service_events.function_call` LogRecords to the same file via
        // the OTLP log exporter (CloudWatch-faithful local mirror).
        const functionDurationHistogram = this.otlpEmitter.getFunctionDurationHistogram();
        if (functionDurationHistogram !== null) {
          // `Telemetry.Source` is the only signal-level base attribute on the
          // per-call dimension set. service.name, environment,
          // deployment.environment.name, the SDK version, deployment id, and
          // VCS attributes all live on the OTel Resource (set in the emitter),
          // so they ride along on every metric data point automatically without
          // bloating the cardinality budget.
          const monitorState = ServiceEventsMonitorState.getInstance();
          monitorState.setMetricBaseAttrs({ 'Telemetry.Source': 'ServiceEvents' });
          monitorState.setFunctionDurationHistogram(functionDurationHistogram);
          diag.info('Wired OTel histogram into monitor state for direct recording');
        }

        // One-shot misconfig warning: function instrumentation is enabled but the allowlist
        // is empty, so no functions will be instrumented (there is no implicit default
        // scope. The process keeps running; profiler/endpoint signals are unaffected.
        if (this.config.packagesInclude.length === 0) {
          diag.warn(
            'OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED=true but ' +
              'OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE is empty — no functions will be ' +
              'instrumented. Set PACKAGES_INCLUDE to opt in.'
          );
        }

        installAstHooks(this.config.packagesExclude, this.config.packagesInclude);
        installEsmHooks(this.config.packagesExclude, this.config.packagesInclude);
        diag.info(
          `Function instrumentation hooks installed (CJS + ESM). Exclude patterns: ${this.config.packagesExclude}`
        );
      }

      // suppressEndpointSummary mirrors OTEL_AWS_APPLICATION_SIGNALS_ENABLED:
      // when App Signals is on, skip emitting EndpointSummary LogRecords (App
      // Signals carries equivalent data). The collector still runs so latency
      // histograms feed IncidentSnapshot triggers.
      const endpointCollector = new EndpointMetricCollector(
        this.config.endpointFlushInterval,
        this.config.environment,
        this.config.serviceName,
        this.config.sdkVersion,
        this.otlpEmitter,
        this.config.resourceAttributes,
        this.config.applicationSignalsEnabled
      );

      // Only instantiate the FunctionCall collector when AST is on — mirrors
      // Python serviceevents_instrumentation.py :173. Without AST, there's no
      // source of FunctionCall data so the collector would emit empty rounds.
      let functionCallCollector: FunctionCallCollector | null = null;
      if (this.config.functionInstrumentEnabled) {
        functionCallCollector = new FunctionCallCollector(
          this.config.functionCallFlushInterval,
          this.config.environment,
          this.config.serviceName,
          this.config.sdkVersion,
          this.otlpEmitter,
          this.config.resourceAttributes
        );
        functionCallCollector.setOperationLookup((operation: string | null) =>
          endpointCollector.lookupOperation(operation)
        );
      }

      const incidentSnapshotCollector = new IncidentSnapshotCollector(
        this.config.incidentSnapshotFlushInterval,
        this.config.incidentSnapshotDurationThresholdMs,
        this.config.incidentSnapshotMaxPerMinute,
        this.config.environment,
        this.config.serviceName,
        this.config.sdkVersion,
        // Request-body capture is hardcoded off (no longer a customer opt-in).
        false,
        this.config.incidentSnapshotMaxSameError,
        this.otlpEmitter,
        this.config.resourceAttributes,
        // Per-endpoint latency thresholds (OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS).
        // Parsed into [pattern, thresholdMs] tuples; the incident collector matches
        // "METHOD /route" against them (first match wins) and falls back to the
        // global threshold otherwise.
        getLatencyThresholdPatterns(this.config)
      );

      if (functionCallCollector) {
        this.collectors.push(functionCallCollector);
      }
      this.collectors.push(endpointCollector, incidentSnapshotCollector);

      // Profiler collector — independent of AST per design (Python parity).
      // Conditionally enabled, hard-gated off in Lambda until prebuild plumbing
      // is added. Trace correlation between IncidentSnapshot and AggregateProfile
      // is now backend-side via traceId/spanId, so no sample-ring wiring is needed.
      if (this.config.profilerEnabled && !isRunningInLambda()) {
        const sampleRing = new SampleRing(10_000);
        const profilerCollector = new ProfilerCollector({
          windowSeconds: this.config.profilerWindowSeconds,
          // Canonical cross-SDK env var is in ms; pprof.time.start needs µs.
          intervalMicros: this.config.profilerSampleIntervalMs * 1000,
          emitter: this.otlpEmitter,
          completedRequests: getCompletedRequests(),
          sampleRing,
          fullPaths: this.config.profilerFullPaths,
        });
        this.collectors.push(profilerCollector);
      }

      if (this.otlpEmitter) {
        this.collectors.push(new DeploymentEventCollector(this.config.deploymentEventFlushInterval, this.otlpEmitter));
      }

      for (const c of this.collectors) c.start();

      // Install universal HTTP patches unconditionally, BEFORE framework hooks.
      // This guarantees profiler correlation works even when Express isn't
      // a dependency (Fastify/Koa/Next.js-only apps). Idempotent.
      try {
        installGlobalHttpPatches();
      } catch (err) {
        diag.warn(`Failed to install global HTTP patches: ${err}`);
      }

      // Framework hooks
      if (this.config.instrumentExpress) {
        try {
          if (installExpressHooks(endpointCollector, incidentSnapshotCollector, this.config.serviceName, this.config)) {
            diag.info('Express instrumentation hooks installed');
          }
        } catch (err) {
          diag.error(`Error installing Express hooks: ${err}`);
        }
      }
      if (this.config.instrumentFastify) {
        try {
          if (installFastifyHooks(endpointCollector, incidentSnapshotCollector, this.config.serviceName, this.config)) {
            diag.info('Fastify instrumentation hooks installed');
          }
        } catch (err) {
          diag.error(`Error installing Fastify hooks: ${err}`);
        }
      }
      if (this.config.instrumentKoa) {
        try {
          if (installKoaHooks(endpointCollector, incidentSnapshotCollector, this.config.serviceName, this.config)) {
            diag.info('Koa instrumentation hooks installed');
          }
        } catch (err) {
          diag.error(`Error installing Koa hooks: ${err}`);
        }
      }
      if (this.config.instrumentNextJs) {
        try {
          if (installNextJsHooks(endpointCollector, incidentSnapshotCollector, this.config.serviceName, this.config)) {
            diag.info('Next.js instrumentation hooks installed');
          }
        } catch (err) {
          diag.error(`Error installing Next.js hooks: ${err}`);
        }
      }

      this._initialized = true;
      diag.info(`ServiceEvents instrumentation initialized (service=${this.config.serviceName})`);
    } catch (err) {
      diag.error(`Failed to initialize ServiceEvents instrumentation: ${err}`);
      this._initialized = false;
    }
  }

  /**
   * Stop collectors and flush buffered telemetry.
   *
   * Returns a promise that resolves once the OTLP emitter has force-flushed and
   * shut down its providers, so callers (e.g. the SIGTERM handler) can AWAIT the
   * final flush instead of letting the process exit with queued telemetry. Each
   * collector's stop() runs a final synchronous collect() first, enqueuing the
   * last window's records before the flush. Never throws.
   */
  async shutdown(): Promise<void> {
    if (!this._initialized) return;

    try {
      try {
        uninstallAstHooks();
      } catch (err) {
        diag.error(`Error uninstalling AST hooks: ${err}`);
      }
      for (const collector of this.collectors) {
        try {
          collector.stop();
        } catch (err) {
          diag.error(`Error stopping collector: ${err}`);
        }
      }
      this.collectors = [];

      const emitter = this.otlpEmitter;
      this.otlpEmitter = null;
      this._initialized = false;

      if (emitter) {
        // Await the force-flush + provider shutdown so a SIGTERM handler that
        // awaits us doesn't drop the final batch.
        await emitter.shutdown().catch(err => diag.debug('OTLP emitter shutdown error', err));
      }
    } catch (err) {
      diag.error(`Error during ServiceEvents shutdown: ${err}`);
    }
  }

  isInitialized(): boolean {
    return this._initialized;
  }
}
