// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OTLP emitter for ServiceEvents signals.
 *
 * Emits the spec signals:
 *   - EndpointSummary       → OTLP LogRecord (eventName=aws.service_events.endpoint_summary)
 *   - FunctionCall          → OTLP LogRecord (eventName=aws.service_events.function_call)
 *                              + OTel Exponential Histogram (name=service.function.duration)
 *   - IncidentSnapshot      → OTLP LogRecord (eventName=aws.service_events.incident_snapshot)
 *   - DeploymentEvent       → OTLP LogRecord (eventName=aws.service_events.deployment_event)
 *   - EndpointErrorMetrics  → OTel Sum metric (Delta, monotonic, unit=Count)
 *
 * Uses dedicated LoggerProvider + MeterProvider to isolate ServiceEvents telemetry
 * from application telemetry.
 */

import { diag, Counter, Histogram, trace, context as otelContext, TraceFlags, ROOT_CONTEXT } from '@opentelemetry/api';
import { Logger, SeverityNumber, AnyValue } from '@opentelemetry/api-logs';
import { LoggerProvider, BatchLogRecordProcessor, LogRecordExporter } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { AggregationOption, AggregationSelector } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';

import { isAwsOtlpEndpoint } from '../../aws-opentelemetry-configurator';
import { OTLPAwsLogExporter } from '../../exporter/otlp/aws/logs/otlp-aws-log-exporter';

import { EndpointMetricEvent, EndpointErrorMetric } from '../models/endpoint-telemetry';
import { FunctionCallMetrics, DurationMetrics } from '../models/function-telemetry';
import { IncidentSnapshot } from '../models/incident-telemetry';
import { DeploymentContext } from '../models/deployment-telemetry';
import {
  ServiceEventsCloudWatchLogFileExporter,
  ServiceEventsCloudWatchMetricFileExporter,
} from './cloudwatch-file-exporter';
import { wrapExporterSuppressed } from './suppressed-exporter';

const INSTRUMENTATION_SCOPE = 'serviceevents';
const INSTRUMENTATION_VERSION = '1.0';

const EVENT_NAME_ENDPOINT_SUMMARY = 'aws.service_events.endpoint_summary';
const EVENT_NAME_FUNCTION_CALL = 'aws.service_events.function_call';
const EVENT_NAME_INCIDENT_SNAPSHOT = 'aws.service_events.incident_snapshot';
const EVENT_NAME_DEPLOYMENT_EVENT = 'aws.service_events.deployment_event';

export interface ServiceEventsOtlpEmitterOptions {
  serviceName?: string;
  environment?: string;
  /**
   * SDK version (LIB_VERSION). Folded into the OTel Resource as
   * `aws.service_events.version` so it rides along with every signal automatically
   * and isn't repeated on every per-call attribute set.
   */
  sdkVersion?: string;
  logsEndpoint?: string;
  metricsEndpoint?: string;
  /**
   * Local-testing file exporter path. When set, the emitter constructs
   * file-backed exporters instead of OTLP network exporters; the `logsEndpoint`
   * and `metricsEndpoint` options are ignored for the duration.
   */
  outputFile?: string;
  deploymentContext?: DeploymentContext;
  /** When true, skip creating dedicated providers (use only if global ones are wired). */
  useGlobalProviders?: boolean;
  /** Optional preconfigured providers (tests may inject mocks). */
  loggerProvider?: LoggerProvider;
  meterProvider?: MeterProvider;
  /**
   * CloudWatch Logs log group. Emitted as `x-aws-log-group` header on each
   * OTLP request — required when `logsEndpoint` is a direct-to-CloudWatch
   * OTLP endpoint (`https://logs.{region}.amazonaws.com/v1/logs`). Ignored
   * for collector-proxied or file-export modes.
   */
  logGroup?: string;
  /**
   * CloudWatch Logs log stream. Emitted as `x-aws-log-stream` header on each
   * OTLP request — same rules as `logGroup`.
   */
  logStream?: string;
}

export class ServiceEventsOtlpEmitter {
  private logger: Logger | null = null;
  private loggerProvider: LoggerProvider | null = null;
  private meterProvider: MeterProvider | null = null;
  private errorCounter: Counter | null = null;
  /**
   * `service.function.duration` exponential histogram. Recorded directly
   * from `__serviceeventsMonitorExit` for sampled calls.
   *
   * Only populated when an OTLP network endpoint is in use; in
   * `output_file` mode it stays null because the CloudWatch metric file
   * exporter only serializes Sum metrics and would silently drop histogram
   * data points.
   */
  private functionDurationHistogram: Histogram | null = null;
  private initFailed: boolean = false;
  private readonly serviceName: string;
  private readonly environment?: string;
  private readonly sdkVersion: string;
  private readonly logsEndpoint: string;
  private readonly metricsEndpoint: string;
  private readonly outputFile: string;
  private readonly deploymentContext: DeploymentContext;
  private readonly externalProviders: boolean;
  private readonly logGroup: string;
  private readonly logStream: string;

  constructor(opts: ServiceEventsOtlpEmitterOptions = {}) {
    this.serviceName = opts.serviceName ?? 'UnknownService';
    // No sentinel: when environment is unset it stays undefined and the
    // deployment.environment resource attribute / environment dimension are omitted.
    this.environment = opts.environment;
    this.sdkVersion = opts.sdkVersion ?? '';
    this.outputFile = opts.outputFile ?? process.env.OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE ?? '';
    this.logsEndpoint = resolveLogsEndpoint(opts.logsEndpoint);
    this.metricsEndpoint = resolveMetricsEndpoint(opts.metricsEndpoint);
    this.deploymentContext = opts.deploymentContext ?? DeploymentContext.fromEnvironment();
    this.externalProviders = !!(opts.loggerProvider || opts.meterProvider);
    if (opts.loggerProvider) {
      this.loggerProvider = opts.loggerProvider;
    }
    if (opts.meterProvider) {
      this.meterProvider = opts.meterProvider;
    }
    this.logGroup = opts.logGroup ?? '';
    // Fall back to serviceName when log stream is unset, mirroring Python:
    // every direct-CW request needs both headers, and the service name is the
    // most sensible per-service default.
    this.logStream = opts.logStream ?? this.serviceName;
  }

  getDeploymentContext(): DeploymentContext {
    return this.deploymentContext;
  }

  /**
   * Return the OTel `service.function.duration` Histogram instrument once
   * the emitter has been initialized. Returns null in `output_file` mode,
   * before the first emit triggers initialization, or if init has failed.
   *
   * Side effect: triggers `ensureInitialized()` on the first call, which
   * lazily builds the LoggerProvider, MeterProvider, exporters, and metric
   * reader. Subsequent calls hit the warm path. Init failure is sticky
   * (`initFailed`), so a transient failure won't be retried — callers fall
   * back to the SEH/EMF aggregation path via `updateAggregations`.
   */
  getFunctionDurationHistogram(): Histogram | null {
    if (!this.ensureInitialized()) return null;
    return this.functionDurationHistogram;
  }

  private ensureInitialized(): boolean {
    if (this.logger && this.errorCounter) return true;
    if (this.initFailed) return false;

    try {
      // aws.local.service duplicates service.name for backend compatibility —
      // the backend currently queries aws.local.service and will migrate to
      // service.name in a future release, at which point this duplicate is removed.
      //
      // SDK version, deployment id, and VCS attributes are folded into the
      // Resource so they flow with every signal (logs + metrics) without
      // being repeated on every per-call attribute set. This keeps
      // `service.function.duration` data points lean.
      const resourceAttrs: Record<string, string> = {
        'service.name': this.serviceName,
        'aws.local.service': this.serviceName,
      };
      // Emit the deployment environment (both the legacy `deployment.environment`
      // and the newer `deployment.environment.name`) only when it is set — there is
      // no `UnknownEnvironment` sentinel, so deployments that don't set
      // OTEL_RESOURCE_ATTRIBUTES / ENVIRONMENT omit the key entirely. Matches Python/Java.
      if (this.environment) {
        resourceAttrs['deployment.environment'] = this.environment;
        resourceAttrs['deployment.environment.name'] = this.environment;
      }
      if (this.sdkVersion) {
        resourceAttrs['aws.service_events.version'] = this.sdkVersion;
      }
      if (this.deploymentContext.deployment_id) {
        resourceAttrs['aws.service_events.deployment.id'] = this.deploymentContext.deployment_id;
      }
      if (this.deploymentContext.git_commit_sha) {
        resourceAttrs['vcs.ref.head.revision'] = this.deploymentContext.git_commit_sha;
      }
      if (this.deploymentContext.git_repo_url) {
        resourceAttrs['vcs.repository.url.full'] = this.deploymentContext.git_repo_url;
      }

      // Merge onto the OTel default resource so SDK-identity attributes
      // (`telemetry.sdk.language` / `.name` / `.version`) flow with every signal —
      // resourceFromAttributes() alone does NOT include them. Our explicit attrs win
      // over the default (merge spec: incoming overrides existing), so the placeholder
      // `service.name` from defaultResource() is replaced by ours. Mirrors Python
      // (Resource.create merges the default) and Java (uses the autoconfigured resource).
      const resource = defaultResource().merge(resourceFromAttributes(resourceAttrs));

      const useFile = !!this.outputFile;

      if (!this.loggerProvider) {
        const logExporter: LogRecordExporter = useFile
          ? new ServiceEventsCloudWatchLogFileExporter(this.outputFile)
          : wrapExporterSuppressed(this.buildLogOtlpExporter(CompressionAlgorithm.NONE));
        this.loggerProvider = new LoggerProvider({
          resource,
          processors: [new BatchLogRecordProcessor(logExporter)],
        });
      }
      this.logger = this.loggerProvider.getLogger(INSTRUMENTATION_SCOPE, INSTRUMENTATION_VERSION);

      if (!this.meterProvider) {
        const metricExporter = useFile
          ? new ServiceEventsCloudWatchMetricFileExporter(this.outputFile)
          : wrapExporterSuppressed(
              new OTLPMetricExporter({
                url: this.metricsEndpoint,
                temporalityPreference: AggregationTemporality.DELTA,
                // OTLPMetricExporter forwards aggregationPreference into its
                // OTLPMetricExporterBase parent, which exposes it to the
                // PeriodicExportingMetricReader via `selectAggregation` —
                // the SDK-mandated path for exporter-driven aggregation
                // selection (see node_modules/@opentelemetry/
                // exporter-metrics-otlp-http/.../OTLPMetricExporterBase.js).
                // No View on the MeterProvider is needed for this to take
                // effect.
                aggregationPreference: serviceEventsAggregationSelector,
              })
            );
        this.meterProvider = new MeterProvider({
          resource,
          readers: [
            new PeriodicExportingMetricReader({
              exporter: metricExporter,
              exportIntervalMillis: 10_000,
            }),
          ],
        });
      }
      const meter = this.meterProvider.getMeter(INSTRUMENTATION_SCOPE, INSTRUMENTATION_VERSION);
      this.errorCounter = meter.createCounter('count', {
        unit: 'Count',
        description: 'ServiceEvents EndpointErrorMetrics counter',
      });

      // service.function.duration histogram is wired in BOTH network and
      // output_file mode: the file metric exporter now emits canonical OTLP
      // metrics JSON (incl. ExponentialHistogram, via its selectAggregation),
      // so the histogram is no longer dropped locally. With the histogram
      // wired, recordFunctionCallMetrics records here and the exit path skips
      // updateAggregations → the SEH/FunctionCallCollector path no-ops
      // automatically (same as network mode). The `aws.service_events.function_call`
      // LogRecord therefore no longer appears in either mode;
      // service.function.duration is the single source of truth.
      this.functionDurationHistogram = meter.createHistogram('service.function.duration', {
        unit: 'Microseconds',
        description: 'Function call duration',
      });

      if (useFile) {
        diag.info(
          `ServiceEvents OTLP emitter initialized (output_file=${this.outputFile}; LOGS_ENDPOINT and METRICS_ENDPOINT ignored)`
        );
      } else {
        diag.info(
          `ServiceEvents OTLP emitter initialized (logs=${this.logsEndpoint}, metrics=${this.metricsEndpoint})`
        );
      }
      return true;
    } catch (err) {
      diag.warn('ServiceEvents: failed to initialize OTLP emitter', err);
      this.initFailed = true;
      return false;
    }
  }

  // ─── EndpointSummary ───────────────────────────────────────────────

  emitEndpointSummary(event: EndpointMetricEvent): void {
    if (!this.ensureInitialized() || !this.logger) return;

    try {
      const attrs: Record<string, string | number | boolean> = {
        'http.request.method': event.method ?? '',
        'url.route': event.route ?? '',
        'aws.service_events.operation': event.operation ?? '',
        'aws.service_events.request.count': event.count ?? 0,
        'aws.service_events.request.faults': event.faults ?? 0,
        'aws.service_events.request.errors': event.errors ?? 0,
        'aws.service_events.incident.count': event.incident_count ?? 0,
      };
      this.putVcsAndDeploymentAttrs(attrs);

      const body: Record<string, unknown> = {};
      if (event.duration) {
        body.duration = durationToDict(event.duration);
      }
      body.exception_breakdown = errorBreakdownToList(event.error_breakdown);
      body.incidents_exemplar = incidentsExemplarToList(event.incidents_exemplar);

      this.emitLog(EVENT_NAME_ENDPOINT_SUMMARY, attrs, body);
    } catch (err) {
      diag.debug('ServiceEvents: error emitting EndpointSummary', err);
    }
  }

  // ─── FunctionCall ──────────────────────────────────────────────────

  // NOTE: This legacy LogRecord path is NOT called when the OTel histogram is
  // wired for direct recording (the default when an OTLP emitter is configured
  // with a real network endpoint). In that mode, __serviceeventsMonitorExit
  // records each sampled function call duration directly into the
  // service.function.duration histogram at call time, and the periodic
  // FunctionCallCollector flush still emits this LogRecord with the
  // EMF-shaped duration aggregations on top — so the histogram and EMF log
  // are complementary signals (latency distribution vs full-fidelity
  // call/error counts).

  /** Emit FunctionCall as OTLP LogRecord (full-fidelity counts + EMF duration). */
  emitFunctionCall(event: FunctionCallMetrics): void {
    if (!this.ensureInitialized() || !this.logger) return;

    try {
      const attrs: Record<string, string | number | boolean> = {
        'aws.service_events.function_name': event.function_name ?? '',
        'aws.service_events.caller': event.caller ?? '',
        'aws.service_events.version': event.version ?? '1',
        // Always emit operation (even if empty) to match Python SDK wire shape.
        'aws.service_events.operation': event.operation ?? '',
      };
      if (event.function_at_line !== undefined) {
        attrs['aws.service_events.function_at_line'] = event.function_at_line;
      }
      if (event.is_async) {
        attrs['aws.service_events.is_async'] = true;
      }
      this.putVcsAndDeploymentAttrs(attrs);

      const body: Record<string, unknown> = {};
      if (event.exceptions && Object.keys(event.exceptions).length > 0) {
        body.exceptions = event.exceptions;
      }
      if (event.duration) {
        body.duration = durationToDict(event.duration);
      }

      this.emitLog(EVENT_NAME_FUNCTION_CALL, attrs, Object.keys(body).length > 0 ? body : undefined);
    } catch (err) {
      diag.debug('ServiceEvents: error emitting FunctionCall', err);
    }
  }

  // ─── IncidentSnapshot ──────────────────────────────────────────────

  emitIncidentSnapshot(snapshot: IncidentSnapshot): void {
    if (!this.ensureInitialized() || !this.logger) return;

    try {
      const operation = snapshot.affected_endpoint ?? '';
      const [method, ...routeParts] = operation.split(' ');
      const route = routeParts.join(' ');

      const attrs: Record<string, string | number | boolean> = {
        'aws.service_events.snapshot_id': snapshot.snapshot_id,
        'aws.service_events.trigger_type': snapshot.trigger_type,
        'aws.service_events.operation': operation,
        'aws.service_events.duration_ms': snapshot.duration_ms ?? 0,
        'aws.service_events.is_partial': snapshot.is_partial,
        'http.request.method': method ?? '',
        'url.route': route ?? '',
        'aws.service_events.request.type': snapshot.request_context?.type ?? 'http',
      };
      const statusCode = snapshot.request_context?.status_code;
      if (typeof statusCode === 'number') {
        attrs['http.response.status_code'] = statusCode;
      }
      this.putVcsAndDeploymentAttrs(attrs);

      const body: Record<string, unknown> = {};
      // Serialize with is_partial semantics (drops duration_ns if partial)
      const rendered = snapshot.toDict();
      if (rendered.exception_info) {
        body.exception_info = rendered.exception_info;
      }
      if (rendered.request_context) {
        body.request_context = rendered.request_context;
      }

      // Trace context: hex strings → (traceId/spanId) on LogRecord built-in fields
      const traceContext = extractTraceContext(snapshot);
      this.emitLog(EVENT_NAME_INCIDENT_SNAPSHOT, attrs, body, traceContext);
    } catch (err) {
      diag.debug('ServiceEvents: error emitting IncidentSnapshot', err);
    }
  }

  // ─── DeploymentEvent ───────────────────────────────────────────────

  emitDeploymentEvent(trigger: string = 'periodic'): void {
    if (!this.ensureInitialized() || !this.logger) return;

    try {
      const attrs: Record<string, string | number | boolean> = {};
      const ctx = this.deploymentContext;
      if (ctx.git_commit_sha) attrs['vcs.ref.head.revision'] = ctx.git_commit_sha;
      if (ctx.git_repo_url) attrs['vcs.repository.url.full'] = ctx.git_repo_url;
      if (ctx.deployment_id) attrs['aws.service_events.deployment.id'] = ctx.deployment_id;
      if (ctx.deployment_url) attrs['aws.service_events.deployment.url'] = ctx.deployment_url;
      if (ctx.deployment_timestamp) attrs['aws.service_events.deployment.timestamp'] = ctx.deployment_timestamp;

      attrs['aws.service_events.deployment.trigger'] = trigger;

      // Body: none per spec §6
      this.emitLog(EVENT_NAME_DEPLOYMENT_EVENT, attrs, undefined);
    } catch (err) {
      diag.debug('ServiceEvents: error emitting DeploymentEvent', err);
    }
  }

  // ─── EndpointErrorMetric (single data-point add) ───────────────────

  emitEndpointErrorMetric(metric: EndpointErrorMetric): void {
    if (!this.ensureInitialized() || !this.errorCounter) return;
    if (!metric || metric.count <= 0) return;

    try {
      // Omit the environment dimension when unset (no sentinel / empty string).
      const dimensions: Record<string, string> = {
        'Telemetry.Source': 'ServiceEvents',
        service_name: metric.service_name ?? '',
        operation: metric.operation ?? '',
        exception: metric.exception ?? '',
      };
      if (metric.environment) {
        dimensions.environment = metric.environment;
      }
      this.errorCounter.add(metric.count, dimensions);
    } catch (err) {
      diag.debug('ServiceEvents: error emitting EndpointErrorMetric', err);
    }
  }

  async shutdown(): Promise<void> {
    if (this.externalProviders) return;
    try {
      if (this.loggerProvider) {
        await this.loggerProvider.forceFlush();
        await this.loggerProvider.shutdown();
      }
    } catch (err) {
      diag.debug('ServiceEvents: error shutting down LoggerProvider', err);
    }
    try {
      if (this.meterProvider) {
        await this.meterProvider.forceFlush();
        await this.meterProvider.shutdown();
      }
    } catch (err) {
      diag.debug('ServiceEvents: error shutting down MeterProvider', err);
    }
    this.logger = null;
    this.errorCounter = null;
    this.functionDurationHistogram = null;
    this.loggerProvider = null;
    this.meterProvider = null;
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private buildLogOtlpExporter(compression: CompressionAlgorithm): LogRecordExporter {
    return buildLogOtlpExporter(this.logsEndpoint, this.logGroup, this.logStream, compression);
  }

  private emitLog(
    eventName: string,
    attributes: Record<string, string | number | boolean>,
    body?: Record<string, unknown>,
    traceContext?: { traceId: string; spanId: string }
  ): void {
    const logger = this.logger;
    if (!logger) return;
    // CloudWatch workaround: duplicate eventName as "event.name" attribute (spec §2)
    attributes['event.name'] = eventName;

    const nowMs = Date.now();
    const emitParams: Parameters<Logger['emit']>[0] = {
      eventName,
      timestamp: [Math.floor(nowMs / 1000), (nowMs % 1000) * 1_000_000],
      attributes,
      severityNumber: SeverityNumber.INFO,
      body: body !== undefined ? (body as unknown as AnyValue) : undefined,
    };
    // Expose built-in traceId/spanId fields on the LogRecord by attaching a
    // synthetic active span to the emit context. The SDK reads trace_id/span_id
    // off the active span in the provided context.
    if (traceContext) {
      const spanCtx = {
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: false,
      };
      emitParams.context = trace.setSpanContext(ROOT_CONTEXT, spanCtx);
    } else {
      emitParams.context = otelContext.active();
    }
    logger.emit(emitParams);
  }

  private putVcsAndDeploymentAttrs(attrs: Record<string, string | number | boolean>): void {
    const ctx = this.deploymentContext;
    if (ctx.git_commit_sha) attrs['vcs.ref.head.revision'] = ctx.git_commit_sha;
    if (ctx.git_repo_url) attrs['vcs.repository.url.full'] = ctx.git_repo_url;
    if (ctx.deployment_id) attrs['aws.service_events.deployment.id'] = ctx.deployment_id;
  }
}

// ─── pure helpers ────────────────────────────────────────────────────

/**
 * Build an OTLP log exporter for the configured logs endpoint.
 *
 * When the endpoint matches the CloudWatch Logs OTLP pattern
 * (`https://logs.{region}.amazonaws.com/v1/logs`), wrap the upstream
 * `OTLPLogExporter` with the ADOT `OTLPAwsLogExporter` so requests are
 * SigV4-signed and the required `x-aws-log-group` / `x-aws-log-stream`
 * headers travel with every batch. Otherwise return a plain upstream
 * `OTLPLogExporter` pointing at the collector-proxied endpoint.
 *
 * Mirrors the Java SDK's behavior in `ServiceEventsInstrumentation.java:557`.
 *
 * Exported for unit testing.
 */
export function buildLogOtlpExporter(
  logsEndpoint: string,
  logGroup: string,
  logStream: string,
  compression: CompressionAlgorithm
): LogRecordExporter {
  if (!isAwsOtlpEndpoint(logsEndpoint, 'logs')) {
    return new OTLPLogExporter({ url: logsEndpoint, compression });
  }
  const headers: Record<string, string> = {};
  if (logGroup) headers['x-aws-log-group'] = logGroup;
  if (logStream) headers['x-aws-log-stream'] = logStream;
  return new OTLPAwsLogExporter(logsEndpoint, { headers, compression });
}

/**
 * AggregationSelector for the ServiceEvents OTLP metric exporter.
 *
 * Forces every Histogram instrument we create on the dedicated MeterProvider
 * (today only `service.function.duration`) onto an exponential histogram
 * aggregation, so the exporter wire format produces dense exponential buckets
 * instead of the SDK's default explicit-bucket histogram, which the
 * Application Signals backend expects for latency percentile queries.
 */
const serviceEventsAggregationSelector: AggregationSelector = (instrumentType: InstrumentType): AggregationOption => {
  switch (instrumentType) {
    case InstrumentType.HISTOGRAM: {
      return { type: AggregationType.EXPONENTIAL_HISTOGRAM };
    }
  }
  return { type: AggregationType.DEFAULT };
};

// ServiceEvents endpoints default to the Application Signals OTLP receiver (port 4316).
// They do NOT fall through to OTEL_EXPORTER_OTLP_*_ENDPOINT — ServiceEvents is isolated
// from the app's standard OTLP pipeline. The logs endpoint env var is shared with the
// Dynamic Instrumentation feature so a single value configures both signals.
function resolveLogsEndpoint(explicit?: string): string {
  return explicit || process.env.OTEL_AWS_OTLP_LOGS_ENDPOINT || 'http://localhost:4316/v1/logs';
}

function resolveMetricsEndpoint(explicit?: string): string {
  return explicit || process.env.OTEL_AWS_OTLP_METRICS_ENDPOINT || 'http://localhost:4316/v1/metrics';
}

function durationToDict(d: DurationMetrics): Record<string, unknown> {
  // Ensure Counts entries are integers (spec requirement, matches Java fix).
  const counts = (d.counts ?? []).map(c => (Number.isFinite(c) ? Math.round(c) : 0));
  return {
    Values: [...(d.values ?? [])],
    Counts: counts,
    Max: d.max ?? 0,
    Min: d.min ?? 0,
    Count: Math.round(d.count ?? 0),
    Sum: d.sum ?? 0,
  };
}

function errorBreakdownToList(
  breakdown: EndpointMetricEvent['error_breakdown'] | undefined
): Array<Record<string, unknown>> {
  if (!breakdown) return [];
  return breakdown.map(entry => ({
    failure_type: entry.failure_type,
    count: entry.count,
    exceptions: (entry.errors ?? []).map(e => ({
      exception_type: e.error_type,
      function_name: e.function_name,
    })),
  }));
}

function incidentsExemplarToList(
  exemplars: EndpointMetricEvent['incidents_exemplar'] | undefined
): Array<Record<string, unknown>> {
  if (!exemplars) return [];
  return exemplars.map(ex => ({
    snapshot_id: ex.snapshot_id,
    trigger_type: ex.trigger_type,
    timestamp: ex.timestamp,
  }));
}

function extractTraceContext(snapshot: IncidentSnapshot): { traceId: string; spanId: string } | undefined {
  const corr = snapshot.telemetry_correlation;
  if (!corr) return undefined;
  const tid = (corr.trace_id ?? '').replace(/^0x/, '');
  const sid = (corr.span_id ?? '').replace(/^0x/, '');
  if (/^[0-9a-fA-F]{32}$/.test(tid) && /^[0-9a-fA-F]{16}$/.test(sid)) {
    return { traceId: tid, spanId: sid };
  }
  return undefined;
}
