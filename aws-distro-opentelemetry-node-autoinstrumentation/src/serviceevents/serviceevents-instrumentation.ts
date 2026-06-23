// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Main entry point for ServiceEvents instrumentation.
 *
 * Manages the lifecycle of AST hooks, monitor state, collectors,
 * OTLP emitter, and framework instrumentations for deep observability
 * of Node.js applications.
 */

import { diag, trace } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ServiceEventsConfig, getLatencyThresholdPatterns } from './config';
import { EndpointServiceEventsSpanProcessor } from './processor/endpoint-span-processor';
import {
  ServiceEventsMonitorState,
  setSamplingMode,
  getSamplingMode,
  setSamplingThresholds,
  setDetachThreshold,
  registerMonitorGlobals,
  unregisterMonitorGlobals,
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

/**
 * Attach a SpanProcessor to whatever tracer provider is globally registered, returning true on
 * success. Exported for unit testing the two registration strategies against stub providers.
 *
 * Strategy, in order:
 *  1. Unwrap the ProxyTracerProvider that `trace.getTracerProvider()` returns to its real delegate
 *     (`getDelegate()`), if present.
 *  2. If the delegate exposes a public `addSpanProcessor(p)` (older OTel SDKs and the shape the
 *     Python distro relies on), call it.
 *  3. Otherwise splice into the live `MultiSpanProcessor` the provider iterates per span:
 *     `delegate._activeSpanProcessor._spanProcessors`. The MultiSpanProcessor reads that array on
 *     every onStart/onEnd, so a late push is honored immediately. This is the supported path on
 *     SDK 2.x, which dropped the public `addSpanProcessor`.
 *
 * All field access is defensive (the SDK internals are not part of the public API), so a future
 * SDK reshape degrades to `false` (caller warns) rather than throwing into ServiceEvents init.
 */
export function registerSpanProcessorOnActiveProvider(processor: SpanProcessor): boolean {
  try {
    const proxy = trace.getTracerProvider() as unknown as {
      getDelegate?: () => unknown;
    };
    const provider = (typeof proxy?.getDelegate === 'function' ? proxy.getDelegate() : proxy) as
      | {
          addSpanProcessor?: (p: SpanProcessor) => void;
          _activeSpanProcessor?: { _spanProcessors?: SpanProcessor[] };
        }
      | undefined;

    if (!provider) {
      return false;
    }

    if (typeof provider.addSpanProcessor === 'function') {
      provider.addSpanProcessor(processor);
      return true;
    }

    const active = provider._activeSpanProcessor;
    if (active && Array.isArray(active._spanProcessors)) {
      active._spanProcessors.push(processor);
      return true;
    }

    return false;
  } catch (err) {
    diag.debug('ServiceEvents: failed to register span processor on active provider', err);
    return false;
  }
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

      // An unrecognized mode — e.g. the removed "adaptive" left in a stale env var — must not
      // abort the whole ServiceEvents init. Log and leave the module default ('always') in place,
      // mirroring the Python distro and the Java bridge (which retain the default on invalid input).
      try {
        setSamplingMode(this.config.samplingMode);
      } catch (err) {
        diag.warn(
          `ServiceEvents: invalid sampling mode '${this.config.samplingMode}'; using '${getSamplingMode()}': ${err}`
        );
      }
      setSamplingThresholds({
        tier1Threshold: this.config.sampleTier1Threshold,
        tier2Threshold: this.config.sampleTier2Threshold,
        tier2Rate: this.config.sampleTier2Rate,
        tier3Rate: this.config.sampleTier3Rate,
      });

      if (this.config.functionDetachThreshold > 0) {
        setDetachThreshold(this.config.functionDetachThreshold);
        diag.info(`Function detach threshold: ${this.config.functionDetachThreshold} calls/sec`);
      }

      // Initialize OTLP emitter — all signals flow here. When logsEndpoint
      // points at the CloudWatch OTLP endpoint, the emitter swaps in the
      // SigV4-signed exporter and injects the configured log-group/stream
      // as headers.
      this.otlpEmitter = new ServiceEventsOtlpEmitter({
        serviceName: this.config.serviceName,
        environment: this.config.environment,
        sdkVersion: this.config.sdkVersion,
        outputFile: this.config.outputFile,
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
        // scope). The process keeps running; endpoint signals are unaffected.
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

      if (this.otlpEmitter) {
        this.collectors.push(new DeploymentEventCollector(this.config.deploymentEventFlushInterval, this.otlpEmitter));
      }

      for (const c of this.collectors) c.start();

      // Endpoint signals come from one of two mutually exclusive sources:
      //   - useSpanProcessor (the default): the framework-agnostic EndpointServiceEventsSpanProcessor
      //     reads the request-boundary span OTel already emits (covers every OTel-instrumented
      //     framework for free, mirrors the Java/Python distros). Owns its own begin→end
      //     investigation lifecycle, so the global http patch + per-framework hooks are NOT installed
      //     (they would double-record and the http patch's res.on('close') backstop would race the
      //     processor's onEnd teardown).
      //   - legacy (flag off): the per-framework hooks + the global http patch (the original JS path).
      //
      // The span processor registers itself on the already-built tracer provider via private SDK
      // internals (SDK 2.x dropped the public addSpanProcessor). If that registration fails, fall
      // back to the legacy hooks rather than emit no endpoint signals at all — the default-on path
      // must never silently lose endpoint metrics on a provider shape we can't splice into.
      const spanProcessorRegistered =
        this.config.useSpanProcessor &&
        this._installEndpointSpanProcessor(endpointCollector, incidentSnapshotCollector);
      if (!spanProcessorRegistered) {
        if (this.config.useSpanProcessor) {
          diag.warn(
            'ServiceEvents: endpoint span processor could not be registered; falling back to the ' +
              'legacy per-framework hooks for endpoint signals.'
          );
        }
        this._installFrameworkHooks(endpointCollector, incidentSnapshotCollector);
      }

      this._initialized = true;
      diag.info(`ServiceEvents instrumentation initialized (service=${this.config.serviceName})`);
    } catch (err) {
      diag.error(`Failed to initialize ServiceEvents instrumentation: ${err}`);
      this._initialized = false;
    }
  }

  /**
   * Default path: install the global HTTP patch (begin signal + sole recorder for Express) plus
   * the per-framework hooks, each gated on its config toggle. This is the original JS endpoint
   * pipeline and remains the default.
   */
  private _installFrameworkHooks(
    endpointCollector: EndpointMetricCollector,
    incidentSnapshotCollector: IncidentSnapshotCollector
  ): void {
    // Install universal HTTP patches unconditionally, BEFORE framework hooks.
    // This guarantees endpoint metrics work even when Express isn't
    // a dependency (Fastify/Koa/Next.js-only apps). Idempotent.
    try {
      installGlobalHttpPatches();
    } catch (err) {
      diag.warn(`Failed to install global HTTP patches: ${err}`);
    }

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
  }

  /**
   * Span-processor path: register the framework-agnostic EndpointServiceEventsSpanProcessor on the
   * active tracer provider. Does NOT install the global http patch or any per-framework hook — the
   * processor owns the whole begin→end lifecycle off the request-boundary span.
   *
   * ServiceEvents initializes after `sdk.start()`, so the provider already exists. OTel JS SDK 2.x
   * removed the public `addSpanProcessor`, and the provider is built once from a fixed
   * `spanProcessors` list. We therefore register defensively: use a public `addSpanProcessor` if the
   * running SDK still exposes one, else splice into the live `MultiSpanProcessor` the provider
   * iterates on every span (its `onStart`/`onEnd` read the array each call, so a late push takes
   * effect immediately).
   *
   * Returns true when the processor was registered, false when neither strategy was reachable so
   * the caller can fall back to the legacy per-framework hooks (the span-processor path is the
   * default, so a registration miss must degrade to the working hooks rather than emit no endpoint
   * signals).
   */
  private _installEndpointSpanProcessor(
    endpointCollector: EndpointMetricCollector,
    incidentSnapshotCollector: IncidentSnapshotCollector
  ): boolean {
    const processor = new EndpointServiceEventsSpanProcessor(endpointCollector, incidentSnapshotCollector, this.config);
    if (registerSpanProcessorOnActiveProvider(processor)) {
      diag.info('ServiceEvents endpoint span processor registered on the active tracer provider');
      return true;
    }
    return false;
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
      // Disable the monitor hot path. Code transformed before shutdown holds captured
      // references to the global monitor functions, so flip the internal enabled flag
      // (and drop the globals) to stop post-shutdown aggregation growth.
      try {
        unregisterMonitorGlobals();
      } catch (err) {
        diag.error(`Error unregistering monitor globals: ${err}`);
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
