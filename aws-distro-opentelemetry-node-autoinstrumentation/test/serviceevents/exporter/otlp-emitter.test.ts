// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { ServiceEventsOtlpEmitter, buildLogOtlpExporter } from '../../../src/serviceevents/exporter/otlp-emitter';
import { EndpointMetricEvent, EndpointErrorMetric } from '../../../src/serviceevents/models/endpoint-telemetry';
import { FunctionCallMetrics } from '../../../src/serviceevents/models/function-telemetry';
import { IncidentSnapshot } from '../../../src/serviceevents/models/incident-telemetry';
import { DeploymentContext } from '../../../src/serviceevents/models/deployment-telemetry';
import { OTLPAwsLogExporter } from '../../../src/exporter/otlp/aws/logs/otlp-aws-log-exporter';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';

// In-memory LoggerProvider that captures emitted LogRecords
class CapturedLogger {
  records: any[] = [];
  emit(record: any): void {
    this.records.push(record);
  }
}

class CapturedLoggerProvider {
  logger: CapturedLogger = new CapturedLogger();
  getLogger(): CapturedLogger {
    return this.logger;
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class CapturedCounter {
  adds: Array<{ value: number; attrs: Record<string, unknown> }> = [];
  add(value: number, attrs: Record<string, unknown>): void {
    this.adds.push({ value, attrs });
  }
}

class CapturedHistogram {
  records: Array<{ value: number; attrs: Record<string, unknown> }> = [];
  record(value: number, attrs: Record<string, unknown>): void {
    this.records.push({ value, attrs });
  }
}

class CapturedMeter {
  counter: CapturedCounter = new CapturedCounter();
  histogram: CapturedHistogram = new CapturedHistogram();
  createCounter(): CapturedCounter {
    return this.counter;
  }
  createHistogram(): CapturedHistogram {
    return this.histogram;
  }
}

class CapturedMeterProvider {
  meter: CapturedMeter = new CapturedMeter();
  getMeter(): CapturedMeter {
    return this.meter;
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

function makeEndpointEvent(): EndpointMetricEvent {
  return new EndpointMetricEvent({
    environment: 'env',
    service_name: 'svc',
    sdk_version: '1.0',
    instance_id: 'inst',
    method: 'POST',
    route: '/trigger',
    operation: 'POST /trigger',
    pid: 1,
    timestamp: new Date().toISOString(),
    count: 10,
    faults: 3,
    errors: 1,
    error_breakdown: [
      {
        errors: [{ error_type: 'TypeError', function_name: 'app.foo' }],
        count: 3,
        failure_type: '500',
      },
    ],
    incident_count: 1,
    incidents_exemplar: [{ snapshot_id: 'snap_x', trigger_type: 'exception', severity: 'critical', timestamp: 123 }],
    duration: { values: [1.5, 2.5], counts: [2, 3], max: 3, min: 1, count: 5, sum: 10 },
    MetricsStats: null,
    resource_attributes: null,
  });
}

function makeFunctionCall(): FunctionCallMetrics {
  return new FunctionCallMetrics({
    environment: 'env',
    service_name: 'svc',
    sdk_version: '1.0',
    instance_id: 'inst',
    function_name: 'app.foo',
    function_at_line: 42,
    pid: 1,
    timestamp: new Date().toISOString(),
    operation: 'POST /trigger',
    caller: 'app.bar',
    is_async: true,
    exceptions: { RuntimeError: 5 },
    duration: { values: [1.5], counts: [5], max: 2, min: 1, count: 5, sum: 10 },
    MetricsStats: null,
    resource_attributes: null,
  });
}

function makeIncidentSnapshot(withTrace: boolean = false): IncidentSnapshot {
  return new IncidentSnapshot({
    snapshot_id: 'snap_1',
    timestamp: Date.now(),
    severity: 'critical',
    trigger_type: 'exception',
    service: 'svc',
    environment: 'env',
    instance_id: 'inst',
    affected_endpoint: 'POST /trigger',
    sdk_version: '1.0',
    pid: 1,
    duration_ms: 27.5,
    is_partial: true,
    exception_info: [
      {
        exception_type: 'TypeError',
        exception_message: 'boom',
        stack_trace: 'trace',
        call_path: [
          { function_name: 'app.foo', caller_function_name: 'app.bar', duration_ns: 1000, error: true },
          { function_name: 'app.bar', caller_function_name: '', duration_ns: 2000, error: false },
        ],
      },
    ],
    request_context: { type: 'http', timestamp: 123, status_code: 500, custom_context: {} },
    telemetry_correlation: withTrace
      ? {
          trace_id: 'aabbccddeeff00112233445566778899',
          span_id: '1122334455667788',
          correlation_ids: {},
        }
      : { correlation_ids: {} },
  });
}

describe('ServiceEventsOtlpEmitter', function () {
  let loggerProvider: CapturedLoggerProvider;
  let meterProvider: CapturedMeterProvider;
  let emitter: ServiceEventsOtlpEmitter;

  beforeEach(function () {
    loggerProvider = new CapturedLoggerProvider();
    meterProvider = new CapturedMeterProvider();
    emitter = new ServiceEventsOtlpEmitter({
      serviceName: 'svc',
      environment: 'env',
      loggerProvider: loggerProvider as any,
      meterProvider: meterProvider as any,
      deploymentContext: new DeploymentContext({
        git_commit_sha: 'abc123',
        git_repo_url: 'https://github.com/x/y',
        deployment_id: 'dep-1',
      }),
    });
  });

  describe('emitEndpointSummary', function () {
    it('emits with correct eventName', function () {
      emitter.emitEndpointSummary(makeEndpointEvent());
      const rec = loggerProvider.logger.records[0];
      expect(rec.eventName).toBe('aws.service_events.endpoint_summary');
    });

    it('sets event.name attribute as CloudWatch workaround', function () {
      emitter.emitEndpointSummary(makeEndpointEvent());
      const rec = loggerProvider.logger.records[0];
      expect(rec.attributes['event.name']).toBe('aws.service_events.endpoint_summary');
    });

    it('populates required spec attributes', function () {
      emitter.emitEndpointSummary(makeEndpointEvent());
      const a = loggerProvider.logger.records[0].attributes;
      expect(a['http.request.method']).toBe('POST');
      expect(a['url.route']).toBe('/trigger');
      expect(a['aws.service_events.operation']).toBe('POST /trigger');
      expect(a['aws.service_events.request.count']).toBe(10);
      expect(a['aws.service_events.request.faults']).toBe(3);
      expect(a['aws.service_events.request.errors']).toBe(1);
      expect(a['aws.service_events.incident.count']).toBe(1);
    });

    it('includes VCS + deployment attributes when set', function () {
      emitter.emitEndpointSummary(makeEndpointEvent());
      const a = loggerProvider.logger.records[0].attributes;
      expect(a['vcs.ref.head.revision']).toBe('abc123');
      expect(a['vcs.repository.url.full']).toBe('https://github.com/x/y');
      expect(a['aws.service_events.deployment.id']).toBe('dep-1');
    });

    it('omits VCS attrs when deployment context is empty', function () {
      const emptyEmitter = new ServiceEventsOtlpEmitter({
        serviceName: 'svc',
        environment: 'env',
        loggerProvider: loggerProvider as any,
        meterProvider: meterProvider as any,
        deploymentContext: new DeploymentContext({}),
      });
      emptyEmitter.emitEndpointSummary(makeEndpointEvent());
      const a = loggerProvider.logger.records[0].attributes;
      expect(a['vcs.ref.head.revision']).toBeUndefined();
      expect(a['vcs.repository.url.full']).toBeUndefined();
      expect(a['aws.service_events.deployment.id']).toBeUndefined();
    });

    it('body has duration/exception_breakdown/incidents_exemplar', function () {
      emitter.emitEndpointSummary(makeEndpointEvent());
      const body = loggerProvider.logger.records[0].body;
      expect(body.duration.Count).toBe(5);
      expect(body.duration.Values).toEqual([1.5, 2.5]);
      expect(body.duration.Counts).toEqual([2, 3]);
      expect(body.exception_breakdown[0].failure_type).toBe('500');
      expect(body.exception_breakdown[0].exceptions[0].function_name).toBe('app.foo');
      expect(body.incidents_exemplar[0].snapshot_id).toBe('snap_x');
    });
  });

  describe('emitFunctionCall', function () {
    it('emits with correct eventName', function () {
      emitter.emitFunctionCall(makeFunctionCall());
      expect(loggerProvider.logger.records[0].eventName).toBe('aws.service_events.function_call');
    });

    it('attributes include function_name, operation, caller, version, function_at_line, is_async', function () {
      emitter.emitFunctionCall(makeFunctionCall());
      const a = loggerProvider.logger.records[0].attributes;
      expect(a['aws.service_events.function_name']).toBe('app.foo');
      expect(a['aws.service_events.operation']).toBe('POST /trigger');
      expect(a['aws.service_events.caller']).toBe('app.bar');
      expect(a['aws.service_events.version']).toBe('1');
      expect(a['aws.service_events.function_at_line']).toBe(42);
      expect(a['aws.service_events.is_async']).toBe(true);
    });

    it('body has exceptions + duration', function () {
      emitter.emitFunctionCall(makeFunctionCall());
      const body = loggerProvider.logger.records[0].body;
      expect(body.exceptions).toEqual({ RuntimeError: 5 });
      expect(body.duration.Count).toBe(5);
    });
  });

  describe('emitIncidentSnapshot', function () {
    it('sets trace context on emit via Context with active SpanContext', function () {
      const { trace } = require('@opentelemetry/api');
      emitter.emitIncidentSnapshot(makeIncidentSnapshot(true));
      const rec = loggerProvider.logger.records[0];
      // The context passed to emit has an active span context. Extract it.
      const span = trace.getSpan(rec.context);
      const spanCtx = span?.spanContext?.();
      expect(spanCtx?.traceId).toBe('aabbccddeeff00112233445566778899');
      expect(spanCtx?.spanId).toBe('1122334455667788');
      expect(spanCtx?.traceFlags).toBe(1);
    });

    it('uses active context when telemetry_correlation missing', function () {
      const { context, trace, ROOT_CONTEXT } = require('@opentelemetry/api');
      // Run under ROOT_CONTEXT: earlier unrelated tests in the full suite may
      // have left an active span in the global context, which would make
      // trace.getSpan(...) resolve to that pollution rather than undefined.
      context.with(ROOT_CONTEXT, () => {
        emitter.emitIncidentSnapshot(makeIncidentSnapshot(false));
      });
      const rec = loggerProvider.logger.records[0];
      const span = trace.getSpan(rec.context);
      expect(span).toBeUndefined();
    });

    it('attributes include spec-required fields', function () {
      emitter.emitIncidentSnapshot(makeIncidentSnapshot(true));
      const a = loggerProvider.logger.records[0].attributes;
      expect(a['aws.service_events.snapshot_id']).toBe('snap_1');
      expect(a['aws.service_events.trigger_type']).toBe('exception');
      expect(a['aws.service_events.operation']).toBe('POST /trigger');
      expect(a['aws.service_events.duration_ms']).toBe(27.5);
      expect(a['aws.service_events.is_partial']).toBe(true);
      expect(a['http.request.method']).toBe('POST');
      expect(a['url.route']).toBe('/trigger');
      expect(a['http.response.status_code']).toBe(500);
      expect(a['aws.service_events.request.type']).toBe('http');
    });

    it('body has exception_info + request_context', function () {
      emitter.emitIncidentSnapshot(makeIncidentSnapshot(true));
      const body = loggerProvider.logger.records[0].body;
      expect(body.exception_info[0].exception_type).toBe('TypeError');
      expect(body.request_context.type).toBe('http');
      expect(body.request_context.status_code).toBe(500);
    });

    it('call_path entries use function_name/caller_function_name (empty string, not null)', function () {
      emitter.emitIncidentSnapshot(makeIncidentSnapshot(true));
      const callPath = loggerProvider.logger.records[0].body.exception_info[0].call_path;
      expect(callPath[0].function_name).toBe('app.foo');
      expect(callPath[0].caller_function_name).toBe('app.bar');
      expect(callPath[1].caller_function_name).toBe('');
    });
  });

  describe('emitDeploymentEvent', function () {
    it('emits with correct eventName and attributes only (empty body)', function () {
      emitter.emitDeploymentEvent();
      const rec = loggerProvider.logger.records[0];
      expect(rec.eventName).toBe('aws.service_events.deployment_event');
      expect(rec.body).toBeUndefined();
      expect(rec.attributes['vcs.ref.head.revision']).toBe('abc123');
      expect(rec.attributes['vcs.repository.url.full']).toBe('https://github.com/x/y');
      expect(rec.attributes['aws.service_events.deployment.id']).toBe('dep-1');
    });
  });

  describe('emitOtlpProfile (spec §8 compressed wrapper)', function () {
    const sampleWrapper = {
      encoding: 'zstd' as const,
      data: 'KLUv/aA3Rw...base64-zstd...==',
      trace_links: [{ trace_id: 'abc123', span_id: 's1' }],
      operations: ['GET /users'],
    };

    it('emits with correct event name and only spec attributes', function () {
      emitter.emitOtlpProfile(sampleWrapper);
      const rec = loggerProvider.logger.records[0];
      expect(rec.eventName).toBe('aws.service_events.aggregate_profile');
      // VCS/deployment attrs still propagate from putVcsAndDeploymentAttrs.
      expect(rec.attributes['vcs.ref.head.revision']).toBe('abc123');
      // Stale attrs from the old design must NOT appear.
      expect(rec.attributes['aws.service_events.aggregation_type']).toBeUndefined();
      expect(rec.attributes['aws.service_events.profile.total_samples']).toBeUndefined();
      expect(rec.attributes['aws.service_events.profile.window_start_ms']).toBeUndefined();
      expect(rec.attributes['aws.service_events.profile.window_end_ms']).toBeUndefined();
      expect(rec.attributes['aws.service_events.operation']).toBeUndefined();
      expect(rec.attributes['aws.service_events.request.count']).toBeUndefined();
    });

    it('body is the compressed wrapper as-is', function () {
      emitter.emitOtlpProfile(sampleWrapper);
      const rec = loggerProvider.logger.records[0];
      expect(rec.body.encoding).toBe('zstd');
      expect(rec.body.data).toBe(sampleWrapper.data);
      expect(rec.body.trace_links).toEqual(sampleWrapper.trace_links);
      expect(rec.body.operations).toEqual(sampleWrapper.operations);
      // Old body keys must NOT appear.
      expect(rec.body.profiler_call_tree).toBeUndefined();
      expect(rec.body.request_statistics).toBeUndefined();
    });

    it('routes aggregate profile records to the dedicated profile logger when injected', function () {
      const profileLoggerProvider = new CapturedLoggerProvider();
      const splitEmitter = new ServiceEventsOtlpEmitter({
        serviceName: 'svc',
        environment: 'env',
        loggerProvider: loggerProvider as any,
        meterProvider: meterProvider as any,
        profileLoggerProvider: profileLoggerProvider as any,
      });

      splitEmitter.emitOtlpProfile(sampleWrapper);

      // The aggregate profile record lands on the dedicated profile provider,
      // not the main logger provider.
      expect(loggerProvider.logger.records.length).toBe(0);
      expect(profileLoggerProvider.logger.records.length).toBe(1);
      expect(profileLoggerProvider.logger.records[0].eventName).toBe('aws.service_events.aggregate_profile');

      // Main-pipeline signals still land on the main provider.
      splitEmitter.emitEndpointSummary(makeEndpointEvent());
      expect(loggerProvider.logger.records.length).toBe(1);
      expect(loggerProvider.logger.records[0].eventName).toBe('aws.service_events.endpoint_summary');
      expect(profileLoggerProvider.logger.records.length).toBe(1);
    });
  });

  describe('emitEndpointErrorMetric', function () {
    it('adds a counter data-point with Telemetry.Source="ServiceEvents"', function () {
      emitter.emitEndpointErrorMetric(
        new EndpointErrorMetric({
          environment: 'env',
          service_name: 'svc',
          operation: 'POST /t',
          instance_id: 'i',
          pid: 1,
          exception: 'RuntimeError',
          count: 3,
        })
      );
      const adds = meterProvider.meter.counter.adds;
      expect(adds.length).toBe(1);
      expect(adds[0].value).toBe(3);
      expect(adds[0].attrs['Telemetry.Source']).toBe('ServiceEvents');
      expect(adds[0].attrs.service_name).toBe('svc');
      expect(adds[0].attrs.environment).toBe('env');
      expect(adds[0].attrs.operation).toBe('POST /t');
      expect(adds[0].attrs.exception).toBe('RuntimeError');
    });

    it('skips zero-count metrics', function () {
      emitter.emitEndpointErrorMetric(
        new EndpointErrorMetric({
          environment: 'env',
          service_name: 'svc',
          operation: 'op',
          instance_id: 'i',
          pid: 1,
          exception: 'T',
          count: 0,
        })
      );
      expect(meterProvider.meter.counter.adds.length).toBe(0);
    });
  });

  describe('shutdown', function () {
    it('is callable multiple times safely with external providers', async function () {
      await emitter.shutdown();
      await emitter.shutdown();
    });
  });

  describe('Resource attributes', function () {
    it('includes aws.local.service as a copy of service.name', async function () {
      // No external provider → emitter builds its own LoggerProvider with the
      // Resource populated from serviceName/environment. Trigger ensureInitialized
      // by emitting a record.
      const ownEmitter = new ServiceEventsOtlpEmitter({
        serviceName: 'my-test-service',
        environment: 'my-env',
        logsEndpoint: 'http://localhost:4316/v1/logs',
        metricsEndpoint: 'http://localhost:4316/v1/metrics',
        deploymentContext: new DeploymentContext({}),
      });
      try {
        ownEmitter.emitDeploymentEvent();
        const resource = (ownEmitter as any).loggerProvider?._sharedState?.resource;
        const attrs = resource?.attributes ?? {};
        expect(attrs['service.name']).toBe('my-test-service');
        expect(attrs['aws.local.service']).toBe('my-test-service');
      } finally {
        await ownEmitter.shutdown();
      }
    });
  });
});

describe('buildLogOtlpExporter', function () {
  it('returns a plain OTLPLogExporter for collector-proxied endpoints', function () {
    const exp = buildLogOtlpExporter(
      'http://localhost:4316/v1/logs',
      '/my/group',
      'my-stream',
      CompressionAlgorithm.NONE
    );
    expect(exp).toBeInstanceOf(OTLPLogExporter);
    expect(exp).not.toBeInstanceOf(OTLPAwsLogExporter);
  });

  it('returns a SigV4-signed OTLPAwsLogExporter for CloudWatch OTLP endpoints', function () {
    const exp = buildLogOtlpExporter(
      'https://logs.us-east-2.amazonaws.com/v1/logs',
      '/my/group',
      'my-stream',
      CompressionAlgorithm.GZIP
    );
    expect(exp).toBeInstanceOf(OTLPAwsLogExporter);
  });

  it('returns a plain OTLPLogExporter for any non-CW https endpoint', function () {
    const exp = buildLogOtlpExporter(
      'https://my-collector.example.com/v1/logs',
      '/my/group',
      'my-stream',
      CompressionAlgorithm.NONE
    );
    expect(exp).toBeInstanceOf(OTLPLogExporter);
    expect(exp).not.toBeInstanceOf(OTLPAwsLogExporter);
  });

  it('does not require logGroup / logStream to construct (they become empty headers)', function () {
    // Construction must not throw when headers are absent — operator
    // misconfiguration surfaces as CloudWatch-side errors, not a crash here.
    const exp = buildLogOtlpExporter('https://logs.us-east-2.amazonaws.com/v1/logs', '', '', CompressionAlgorithm.NONE);
    expect(exp).toBeInstanceOf(OTLPAwsLogExporter);
  });
});

describe('ServiceEventsOtlpEmitter resource attributes', function () {
  // These tests let the emitter build its OWN LoggerProvider (no injected provider),
  // so the real Resource-construction path runs. outputFile mode keeps it offline
  // (file exporter, no network endpoint required).
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  let outFile: string;

  function makeEmitter(opts: Record<string, unknown> = {}): ServiceEventsOtlpEmitter {
    outFile = path.join(
      os.tmpdir(),
      `se-otlp-emitter-res-${process.pid}-${Math.random().toString(36).slice(2)}.ndjson`
    );
    return new ServiceEventsOtlpEmitter({ serviceName: 'svc', outputFile: outFile, ...opts });
  }

  function resourceAttrsOf(emitter: ServiceEventsOtlpEmitter): Record<string, unknown> {
    // Trigger lazy ensureInitialized(), then read the resource the emitter built on its
    // own LoggerProvider. The sdk-logs LoggerProvider keeps the resource on internal
    // `_sharedState` (no public getter), so fall back to that — synchronous and
    // deterministic, vs. flushing the batch processor to disk and re-parsing.
    emitter.emitEndpointSummary(makeEndpointEvent());
    const lp = (emitter as any).loggerProvider;
    const resource = lp?.resource ?? lp?._sharedState?.resource;
    if (!resource) {
      throw new Error('could not locate the LoggerProvider resource (SDK internals changed?)');
    }
    return resource.attributes as Record<string, unknown>;
  }

  afterEach(function () {
    try {
      if (outFile && fs.existsSync(outFile)) fs.unlinkSync(outFile);
    } catch {
      /* best-effort temp cleanup */
    }
  });

  it('includes telemetry.sdk.* from the merged default resource', function () {
    // Regression: resourceFromAttributes() alone omits these; the emitter must merge
    // defaultResource() so every signal carries SDK identity (parity with Python/Java).
    const attrs = resourceAttrsOf(makeEmitter({ environment: 'prod' }));
    expect(attrs['telemetry.sdk.language']).toBe('nodejs');
    expect(attrs['telemetry.sdk.name']).toBe('opentelemetry');
    expect(typeof attrs['telemetry.sdk.version']).toBe('string');
  });

  it('keeps the explicit service.name (wins over defaultResource placeholder)', function () {
    const attrs = resourceAttrsOf(makeEmitter({ serviceName: 'my-api', environment: 'prod' }));
    expect(attrs['service.name']).toBe('my-api');
    expect(attrs['aws.local.service']).toBe('my-api');
  });

  it('emits deployment.environment(.name) when the environment is set', function () {
    const attrs = resourceAttrsOf(makeEmitter({ environment: 'prod' }));
    expect(attrs['deployment.environment']).toBe('prod');
    expect(attrs['deployment.environment.name']).toBe('prod');
  });

  it('omits deployment.environment(.name) entirely when environment is unset (no sentinel)', function () {
    // No "UnknownEnvironment" sentinel: deployments that don't set
    // OTEL_RESOURCE_ATTRIBUTES / ENVIRONMENT omit the key entirely, matching Python/Java.
    const attrs = resourceAttrsOf(makeEmitter()); // no environment → key absent
    expect(attrs['deployment.environment']).toBeUndefined();
    expect(attrs['deployment.environment.name']).toBeUndefined();
  });
});
