// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AWSCloudWatchEMFExporter } from '../src/exporter/aws/metrics/aws-cloudwatch-emf-exporter';
import { propagation, ROOT_CONTEXT, Span, TextMapGetter, trace, TraceFlags, Tracer } from '@opentelemetry/api';
import { OTLPMetricExporter as OTLPGrpcOTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as OTLPHttpOTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter as OTLPGrpcLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPLogExporter as OTLPHttpLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { emptyResource, resourceFromAttributes } from '@opentelemetry/resources';
import { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  ReadableSpan,
  SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import type { Sampler, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import * as assert from 'assert';
import expect from 'expect';
import * as sinon from 'sinon';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { AlwaysRecordSampler } from '../src/always-record-sampler';
import { AttributePropagatingSpanProcessor } from '../src/attribute-propagating-span-processor';
import { AttributeRedactingSpanProcessor } from '../src/attribute-redacting-span-processor';
import { AwsBatchUnsampledSpanProcessor } from '../src/aws-batch-unsampled-span-processor';
import { AwsMetricAttributesSpanExporter } from '../src/aws-metric-attributes-span-exporter';
import {
  ApplicationSignalsExporterProvider,
  AwsLoggerProcessorProvider,
  AwsOpentelemetryConfigurator,
  AwsSpanProcessorProvider,
  checkEmfExporterEnabled,
  createAwsOtlpMetricExporter,
  createEmfExporter,
  customBuildSamplerFromEnv,
  hasExplicitAuthorizationHeader,
  isAwsOtlpEndpoint,
  validateAndFetchLogsHeader,
} from '../src/aws-opentelemetry-configurator';
import { OTLPAwsMetricExporter } from '../src/exporter/otlp/aws/metrics/otlp-aws-metric-exporter';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { AwsSpanMetricsProcessor } from '../src/aws-span-metrics-processor';
import { OTLPUdpSpanExporter } from '../src/otlp-udp-exporter';
let setAwsDefaultEnvironmentVariables: () => void;
import { AwsXRayRemoteSampler } from '../src/sampler/aws-xray-remote-sampler';
import { AwsXraySamplingClient } from '../src/sampler/aws-xray-sampling-client';
import { GetSamplingRulesResponse } from '../src/sampler/remote-sampler.types';
import { BaggageSpanProcessor } from '@opentelemetry/baggage-span-processor';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { AWS_ATTRIBUTE_KEYS } from '../src/aws-attribute-keys';
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { OTLPAwsLogExporter } from '../src/exporter/otlp/aws/logs/otlp-aws-log-exporter';
import { OTLPAwsSpanExporter } from '../src/exporter/otlp/aws/traces/otlp-aws-span-exporter';
import { AwsCloudWatchOtlpBatchLogRecordProcessor } from '../src/exporter/otlp/aws/logs/aws-cw-otlp-batch-log-record-processor';
import { TRACE_PARENT_HEADER } from '@opentelemetry/core';
import { ConsoleEMFExporter } from '../src/exporter/aws/metrics/console-emf-exporter';
import { GenAINestedClientSpanProcessor } from '../src/gen-ai-nested-client-span-processor';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// Tests AwsOpenTelemetryConfigurator after running Environment Variable setup in register.ts
describe('AwsOpenTelemetryConfiguratorTest', () => {
  let awsOtelConfigurator: AwsOpentelemetryConfigurator;

  // setUpClass
  before(() => {
    const stub = sinon.stub(opentelemetry.NodeSDK.prototype, 'start');
    const register = require('../src/register');
    stub.restore();
    setAwsDefaultEnvironmentVariables = register.setAwsDefaultEnvironmentVariables;

    // Run environment setup in register.ts, then validate expected env values.
    setAwsDefaultEnvironmentVariables();
    validateConfiguratorEnviron();

    // Overwrite exporter configs to keep tests clean, set sampler configs for tests
    process.env.OTEL_TRACES_EXPORTER = 'none';
    process.env.OTEL_METRICS_EXPORTER = 'none';
    process.env.OTEL_LOGS_EXPORTER = 'none';
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio';
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.01';

    // Create configurator
    awsOtelConfigurator = new AwsOpentelemetryConfigurator([]);
  });

  // Cleanup any span processors to avoid unit test conflicts
  after(() => {
    (awsOtelConfigurator as any).spanProcessors.forEach((spanProcessor: SpanProcessor) => {
      spanProcessor.shutdown();
    });

    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.OTEL_METRICS_EXPORTER;
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_TRACES_SAMPLER;
    delete process.env.OTEL_TRACES_SAMPLER_ARG;
  });

  // The probability of this passing once without correct IDs is low, 20 times is inconceivable.
  it('ProvideGenerateXrayIdsTest', () => {
    const config = awsOtelConfigurator.configure();
    const spanProcessors = [
      ...(config.spanProcessors || []),
      AttributePropagatingSpanProcessor.create((span: ReadableSpan) => '', 'spanNameKey', ['testKey1', 'testKey2']),
    ];
    const tracerProvider: NodeTracerProvider = new NodeTracerProvider({ ...config, spanProcessors });
    for (let _: number = 0; _ < 20; _++) {
      const tracer: Tracer = tracerProvider.getTracer('test');
      const startTimeSec: number = Math.floor(new Date().getTime() / 1000.0);
      const span: Span = tracer.startSpan('test');
      const traceId: string = span.spanContext().traceId;
      span.end();
      const traceId4ByteHex: string = traceId.substring(0, 8);
      const traceId4ByteNumber: number = Number(`0x${traceId4ByteHex}`);
      expect(traceId4ByteNumber).toBeGreaterThanOrEqual(startTimeSec);
    }
  });

  describe('Propagator Extraction', () => {
    const envVarsToRestore: NodeJS.ProcessEnv = {};
    beforeEach(() => {
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('OTEL_')) {
          envVarsToRestore[key] = value;
          delete process.env[key];
        }
      }
    });

    afterEach(() => {
      // Clean-up
      for (const [key, value] of Object.entries(envVarsToRestore)) {
        process.env[key] = value;
      }
    });

    it('Default Propagator extraction of Trace Context works if only X-Ray Trace Header is set', () => {
      const carrier: Record<string, string> = {
        'X-Amzn-Trace-Id':
          'Root=1-5759e988-bd862e3fe1bf46a994270000;Parent=53945c3f42cd0000;Sampled=1;Lineage=a87bd80c:1|68fd508a:5|c512fbe3:2',
      };
      const textMapGetter: TextMapGetter = {
        keys: (carrier: Record<string, string>): string[] => {
          return Object.keys(carrier);
        },
        get: (carrier: Record<string, string>, key: string) => {
          return carrier?.[key];
        },
      };

      // Create configurator with default settings and AgentObservability enabled for this test case
      setAwsDefaultEnvironmentVariables();
      const customAwsOtelConfigurator = new AwsOpentelemetryConfigurator([]);
      const customAwsOtelConfiguration = customAwsOtelConfigurator.configure();

      const tracerProvider: NodeTracerProvider = new NodeTracerProvider(customAwsOtelConfiguration);
      const tracer: Tracer = tracerProvider.getTracer('test');

      const contextAfterExtraction = customAwsOtelConfiguration.textMapPropagator?.extract(
        ROOT_CONTEXT,
        carrier,
        textMapGetter
      );

      // Test Trace Context extraction directly
      const spanContextAfterExtraction = trace.getSpanContext(contextAfterExtraction!);
      expect(spanContextAfterExtraction?.traceId).toEqual('5759e988bd862e3fe1bf46a994270000');
      expect(spanContextAfterExtraction?.spanId).toEqual('53945c3f42cd0000');
      expect(spanContextAfterExtraction?.traceFlags).toEqual(1);

      // Test Trace Context extraction indirectly through span creation
      const span: Span = tracer.startSpan('test', undefined, contextAfterExtraction);
      span.end();
      const spanContext = span.spanContext();

      expect(spanContext.traceId).toEqual('5759e988bd862e3fe1bf46a994270000');
      // OTel 2.x: parentSpanId moved to parentSpanContext?.spanId
      expect((span as any).parentSpanContext?.spanId).toEqual('53945c3f42cd0000');
      expect(spanContext.traceFlags).toEqual(1);
    });

    it('Default Propagator extraction of Trace Context prioritizes W3C Trace Header over X-Ray Trace Header for span context if they mismatch', () => {
      const carrier: Record<string, string> = {
        'X-Amzn-Trace-Id':
          'Root=1-5759e988-bd862e3fe1bf46a994270000;Parent=53945c3f42cd0000;Sampled=0;Lineage=a87bd80c:1|68fd508a:5|c512fbe3:2',
        [TRACE_PARENT_HEADER]: '00-11111111222222223333333344444444-5555555566666666-01',
      };
      const textMapGetter: TextMapGetter = {
        keys: (carrier: Record<string, string>): string[] => {
          return Object.keys(carrier);
        },
        get: (carrier: Record<string, string>, key: string) => {
          return carrier?.[key];
        },
      };

      // Create configurator with default settings and AgentObservability enabled for this test case
      setAwsDefaultEnvironmentVariables();
      const customAwsOtelConfigurator = new AwsOpentelemetryConfigurator([]);
      const customAwsOtelConfiguration = customAwsOtelConfigurator.configure();

      const tracerProvider: NodeTracerProvider = new NodeTracerProvider(customAwsOtelConfiguration);
      const tracer: Tracer = tracerProvider.getTracer('test');

      const contextAfterExtraction = customAwsOtelConfiguration.textMapPropagator?.extract(
        ROOT_CONTEXT,
        carrier,
        textMapGetter
      );

      // Test Trace Context extraction directly
      const spanContextAfterExtraction = trace.getSpanContext(contextAfterExtraction!);
      expect(spanContextAfterExtraction?.traceId).toEqual('11111111222222223333333344444444');
      expect(spanContextAfterExtraction?.spanId).toEqual('5555555566666666');
      expect(spanContextAfterExtraction?.traceFlags).toEqual(1);

      // Test Trace Context extraction indirectly through span creation
      const span: Span = tracer.startSpan('test', undefined, contextAfterExtraction);
      span.end();
      const spanContext = span.spanContext();

      expect(spanContext.traceId).toEqual('11111111222222223333333344444444');
      // OTel 2.x: parentSpanId moved to parentSpanContext?.spanId
      expect((span as any).parentSpanContext?.spanId).toEqual('5555555566666666');
      expect(spanContext.traceFlags).toEqual(1);
    });

    it('Propagator extracts session.id baggage header attribute into to span attributes when Agent Observability is enabled', () => {
      // Create configurator with default settings and AgentObservability enabled for this test case
      setAwsDefaultEnvironmentVariables();
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
      const customAwsOtelConfigurator = new AwsOpentelemetryConfigurator([]);
      const customAwsOtelConfiguration = customAwsOtelConfigurator.configure();

      const tracerProvider: NodeTracerProvider = new NodeTracerProvider(customAwsOtelConfiguration);
      const tracer: Tracer = tracerProvider.getTracer('test');

      const carrier: Record<string, string> = {
        baggage: 'session.id=test-adot-js-dev',
      };
      const textMapGetter: TextMapGetter = {
        keys: (carrier: Record<string, string>): string[] => {
          return Object.keys(carrier);
        },
        get: (carrier: Record<string, string>, key: string) => {
          return carrier?.[key];
        },
      };
      const contextAfterExtraction = customAwsOtelConfiguration.textMapPropagator?.extract(
        ROOT_CONTEXT,
        carrier,
        textMapGetter
      );

      // Test baggage is set directly
      const baggageAfterExtraction = propagation.getBaggage(contextAfterExtraction!);
      expect(baggageAfterExtraction?.getAllEntries().length).toEqual(1);
      expect(baggageAfterExtraction?.getEntry('session.id')?.value).toEqual('test-adot-js-dev');

      // Test baggage is set indirectly through span creation
      const span: Span = tracer.startSpan('test', undefined, contextAfterExtraction);
      span.end();
      expect((span as any).attributes['session.id']).toEqual('test-adot-js-dev');
    });
  });

  // Sanity check that the trace ID ratio sampler works fine with the x-ray generator.
  it('TraceIdRatioSamplerTest', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    const config = awsOtelConfigurator.configure();
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;

    const spanProcessors = [
      ...(config.spanProcessors || []),
      AttributePropagatingSpanProcessor.create((span: ReadableSpan) => '', 'spanNameKey', ['testKey1', 'testKey2']),
    ];
    const tracerProvider: NodeTracerProvider = new NodeTracerProvider({ ...config, spanProcessors });
    for (let _: number = 0; _ < 20; _++) {
      const numSpans: number = 100000;
      let numSampled: number = 0;
      const tracer: Tracer = tracerProvider.getTracer('test');
      for (let __: number = 0; __ < numSpans; __++) {
        const span: Span = tracer.startSpan('test');
        if (span.spanContext().traceFlags & TraceFlags.SAMPLED) {
          numSampled += 1;
        }
        span.end();
      }
      // Configured for 1%, confirm there are at most 5% to account for randomness and reduce test flakiness.
      expect(0.05).toBeGreaterThan(numSampled / numSpans);
    }
  });

  it('ImportDefaultSamplerWhenEnvVarIsNotSetTest', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    const defaultSampler: Sampler = customBuildSamplerFromEnv(emptyResource());

    expect(defaultSampler).not.toBeUndefined();
    expect(defaultSampler.toString()).toEqual(new ParentBasedSampler({ root: new AlwaysOnSampler() }).toString());
  });

  it('ImportXRaySamplerWhenEnvVarIsSetTest', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    process.env.OTEL_TRACES_SAMPLER = 'xray';
    const sampler = customBuildSamplerFromEnv(emptyResource());

    expect(sampler).toBeInstanceOf(AwsXRayRemoteSampler);
    expect((sampler as any)._root._root.awsProxyEndpoint).toEqual('http://localhost:2000');
    expect((sampler as any)._root._root.rulePollingIntervalMillis).toEqual(300000); // ms

    clearInterval((sampler as any)._root._root.rulePoller);
    clearInterval((sampler as any)._root._root.targetPoller);
  });

  it('ImportXRaySamplerWhenSamplerArgsSet', () => {
    delete process.env.OTEL_TRACES_SAMPLER;

    process.env.OTEL_TRACES_SAMPLER = 'xray';
    process.env.OTEL_TRACES_SAMPLER_ARG = 'endpoint=http://asdfghjkl:2000,polling_interval=600'; // seconds
    const sampler = customBuildSamplerFromEnv(emptyResource());

    expect(sampler).toBeInstanceOf(AwsXRayRemoteSampler);
    expect((sampler as any)._root._root.awsProxyEndpoint).toEqual('http://asdfghjkl:2000');
    expect((sampler as any)._root._root.rulePollingIntervalMillis).toEqual(600000); // ms
    expect(((sampler as any)._root._root.samplingClient as any).getSamplingRulesEndpoint).toEqual(
      'http://asdfghjkl:2000/GetSamplingRules'
    );
    expect(((sampler as any)._root._root.samplingClient as any).samplingTargetsEndpoint).toEqual(
      'http://asdfghjkl:2000/SamplingTargets'
    );

    clearInterval((sampler as any)._root._root.rulePoller);
    clearInterval((sampler as any)._root._root.targetPoller);
  });

  it('ImportXRaySamplerWithInvalidPollingIntervalSet', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    delete process.env.OTEL_TRACES_SAMPLER_ARG;

    process.env.OTEL_TRACES_SAMPLER = 'xray';
    process.env.OTEL_TRACES_SAMPLER_ARG = 'endpoint=http://asdfghjkl:2000,polling_interval=FOOBAR';

    const sampler = customBuildSamplerFromEnv(emptyResource());

    expect(sampler).toBeInstanceOf(AwsXRayRemoteSampler);
    expect((sampler as any)._root._root.awsProxyEndpoint).toEqual('http://asdfghjkl:2000');
    expect((sampler as any)._root._root.rulePollingIntervalMillis).toEqual(300000); // default value
    expect(((sampler as any)._root._root.samplingClient as any).getSamplingRulesEndpoint).toEqual(
      'http://asdfghjkl:2000/GetSamplingRules'
    );
    expect(((sampler as any)._root._root.samplingClient as any).samplingTargetsEndpoint).toEqual(
      'http://asdfghjkl:2000/SamplingTargets'
    );

    clearInterval((sampler as any)._root._root.rulePoller);
    clearInterval((sampler as any)._root._root.targetPoller);
  });

  // test_import_xray_sampler_with_invalid_environment_arguments
  it('ImportXRaySamplerWithInvalidURLSet', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    delete process.env.OTEL_TRACES_SAMPLER_ARG;

    process.env.OTEL_TRACES_SAMPLER = 'xray';
    process.env.OTEL_TRACES_SAMPLER_ARG = 'endpoint=http://lo=cal=host=:2000,polling_interval=600';

    const tmp = (AwsXraySamplingClient.prototype as any).makeSamplingRequest;
    (AwsXraySamplingClient.prototype as any).makeSamplingRequest = (
      url: string,
      callback: (responseObject: GetSamplingRulesResponse) => void
    ) => {
      callback({});
    };

    let sampler = customBuildSamplerFromEnv(emptyResource());

    expect(sampler).toBeInstanceOf(AwsXRayRemoteSampler);
    expect((sampler as any)._root._root.awsProxyEndpoint).toEqual('http://lo=cal=host=:2000');
    expect((sampler as any)._root._root.rulePollingIntervalMillis).toEqual(600000);
    expect(((sampler as any)._root._root.samplingClient as any).getSamplingRulesEndpoint).toEqual(
      'http://lo=cal=host=:2000/GetSamplingRules'
    );
    expect(((sampler as any)._root._root.samplingClient as any).samplingTargetsEndpoint).toEqual(
      'http://lo=cal=host=:2000/SamplingTargets'
    );

    process.env.OTEL_TRACES_SAMPLER_ARG = 'abc,polling_interval=550,123';

    sampler = customBuildSamplerFromEnv(emptyResource());

    expect(sampler).toBeInstanceOf(AwsXRayRemoteSampler);
    expect((sampler as any)._root._root.awsProxyEndpoint).toEqual('http://localhost:2000');
    expect((sampler as any)._root._root.rulePollingIntervalMillis).toEqual(550000);
    expect(((sampler as any)._root._root.samplingClient as any).getSamplingRulesEndpoint).toEqual(
      'http://localhost:2000/GetSamplingRules'
    );
    expect(((sampler as any)._root._root.samplingClient as any).samplingTargetsEndpoint).toEqual(
      'http://localhost:2000/SamplingTargets'
    );

    (AwsXraySamplingClient.prototype as any).makeSamplingRequest = tmp;
  });

  it('IsApplicationSignalsEnabledTest', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeTruthy();
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'False';
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeFalsy();
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'abcdefg';
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeFalsy();
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True_abcdefg';
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeFalsy();
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'abcdefg_True';
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeFalsy();
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = '0';
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeFalsy();
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = '1';
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeFalsy();
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    expect(AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()).toBeFalsy();
  });

  it('CustomizeSamplerTest', () => {
    const mockSampler: Sampler = sinon.createStubInstance(AlwaysOnSampler);
    let customizedSampler: Sampler = AwsOpentelemetryConfigurator.customizeSampler(mockSampler);
    expect(mockSampler).toEqual(customizedSampler);

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    customizedSampler = AwsOpentelemetryConfigurator.customizeSampler(mockSampler);
    expect(mockSampler).not.toEqual(customizedSampler);
    expect(customizedSampler).toBeInstanceOf(AlwaysRecordSampler);
    expect(mockSampler).toEqual((customizedSampler as any).rootSampler);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
  });

  it('CustomizeExporterTest', () => {
    const mockExporter: SpanExporter = sinon.createStubInstance(AwsMetricAttributesSpanExporter);
    let customizedExporter: SpanExporter = AwsSpanProcessorProvider.customizeSpanExporter(
      mockExporter,
      emptyResource()
    );
    expect(mockExporter).toEqual(customizedExporter);

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    customizedExporter = AwsSpanProcessorProvider.customizeSpanExporter(mockExporter, emptyResource());
    expect(mockExporter).not.toEqual(customizedExporter);
    expect(customizedExporter).toBeInstanceOf(AwsMetricAttributesSpanExporter);
    expect(mockExporter).toEqual((customizedExporter as any).delegate);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
  });

  it('CustomizeSpanProcessorsTest', () => {
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.AGENT_OBSERVABILITY_ENABLED;

    // Test application signals only
    let spanProcessors: SpanProcessor[] = [];
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, emptyResource());
    expect(spanProcessors.length).toEqual(2);
    expect(spanProcessors[0]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    expect(spanProcessors[1]).toBeInstanceOf(BaggageSpanProcessor);

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, emptyResource());
    expect(spanProcessors.length).toEqual(6);
    expect(spanProcessors[0]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    expect(spanProcessors[1]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    expect(spanProcessors[2]).toBeInstanceOf(BaggageSpanProcessor);
    expect(spanProcessors[3]).toBeInstanceOf(BaggageSpanProcessor);
    expect(spanProcessors[4]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect(spanProcessors[5]).toBeInstanceOf(AwsSpanMetricsProcessor);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;

    try {
      process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
      process.env.OTEL_METRIC_EXPORT_INTERVAL = undefined;
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, emptyResource());
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '123abc';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, emptyResource());
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '!@#$%^&*()';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, emptyResource());
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '40000';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, emptyResource());
    } catch (e: any) {
      assert.fail(`AwsOpentelemetryConfigurator.customizeSpanProcessors() has incorrectly thrown error: ${e}`);
    } finally {
      delete process.env.OTEL_METRIC_EXPORT_INTERVAL;
      delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    }

    // shut down exporters for test cleanup
    spanProcessors.forEach(spanProcessor => {
      spanProcessor.shutdown();
    });

    // Reset spanProcessors list for next set of tests
    spanProcessors = [];

    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, emptyResource());
    expect(spanProcessors.length).toEqual(5);

    // Verify processors are added in the expected order
    expect(spanProcessors[0]).toBeInstanceOf(GenAINestedClientSpanProcessor);
    expect(spanProcessors[1]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    expect(spanProcessors[2]).toBeInstanceOf(BaggageSpanProcessor);
    expect(spanProcessors[3]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect(spanProcessors[4]).toBeInstanceOf(AwsSpanMetricsProcessor);

    // shut down exporters for test cleanup
    spanProcessors.forEach(spanProcessor => {
      spanProcessor.shutdown();
    });
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
  });

  it('CustomizeSpanProcessorsWithAgentObservabilityTest', () => {
    const spanProcessorsToTest: SpanProcessor[] = [];

    // Test that redaction and baggage processors are added when agent observability is disabled
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, emptyResource());
    expect(spanProcessorsToTest.length).toEqual(2);

    expect(spanProcessorsToTest[0]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    const addedProcessor = spanProcessorsToTest[1];
    expect(addedProcessor).toBeInstanceOf(BaggageSpanProcessor);

    // Clean up
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
  });

  it('registers the GenAI and attribute redacting processors before exporter processors', async () => {
    const previousAgentObservability = process.env.AGENT_OBSERVABILITY_ENABLED;
    const previousTracesExporter = process.env.OTEL_TRACES_EXPORTER;
    const previousTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const previousBaseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    let processors: SpanProcessor[] = [];

    try {
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
      process.env.OTEL_TRACES_EXPORTER = 'otlp';
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

      const config = new AwsOpentelemetryConfigurator([]).configure();
      processors = config.spanProcessors ?? [];

      expect(processors[0]).toBeInstanceOf(GenAINestedClientSpanProcessor);
      expect(processors[1]).toBeInstanceOf(AttributeRedactingSpanProcessor);
      expect(processors[2]).toBeInstanceOf(BatchSpanProcessor);
    } finally {
      await Promise.all(processors.map(processor => processor.shutdown()));
      restoreEnv('AGENT_OBSERVABILITY_ENABLED', previousAgentObservability);
      restoreEnv('OTEL_TRACES_EXPORTER', previousTracesExporter);
      restoreEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', previousTracesEndpoint);
      restoreEnv('OTEL_EXPORTER_OTLP_ENDPOINT', previousBaseEndpoint);
    }
  });

  it('BaggageSpanProcessorSessionIdFilteringTest', () => {
    // Set up agent observability
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    delete process.env.OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS;

    // Create a SpanProcessor list for this test
    const spanProcessorsToTest: SpanProcessor[] = [];

    // Add our span processors
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, emptyResource());

    // Verify that the BaggageSpanProcessor was added
    const baggageProcessors = spanProcessorsToTest.filter(
      processor => processor.constructor.name === 'BaggageSpanProcessor'
    );
    expect(baggageProcessors.length).toBe(1);

    // Verify the predicate function only accepts session.id
    const baggageProcessor = baggageProcessors[0];
    expect(baggageProcessor).toBeInstanceOf(BaggageSpanProcessor);
    const predicate = (baggageProcessor as BaggageSpanProcessor)['_keyPredicate'].bind(baggageProcessor);

    // Test the predicate function directly
    expect(predicate('session.id')).toBeTruthy();
    expect(predicate('user.id')).toBeFalsy();
    expect(predicate('request.id')).toBeFalsy();
    expect(predicate('other.key')).toBeFalsy();
    expect(predicate('')).toBeFalsy();
    expect(predicate('session')).toBeFalsy();
    expect(predicate('id')).toBeFalsy();

    // Clean up
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS;
  });

  it('BaggageSpanProcessorCustomKeysTest', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    process.env.OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS = 'user.id, request.id';

    const spanProcessorsToTest: SpanProcessor[] = [];
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, emptyResource());

    const baggageProcessor = spanProcessorsToTest.find(p => p instanceof BaggageSpanProcessor)!;
    const predicate = (baggageProcessor as BaggageSpanProcessor)['_keyPredicate'].bind(baggageProcessor);

    expect(predicate('user.id')).toBeTruthy();
    expect(predicate('request.id')).toBeTruthy();
    expect(predicate('session.id')).toBeTruthy();

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS;
  });

  it('BaggageSpanProcessorRejectsKeysWithoutCustomConfigTest', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    delete process.env.OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS;

    const spanProcessorsToTest: SpanProcessor[] = [];
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, emptyResource());

    const baggageProcessor = spanProcessorsToTest.find(p => p instanceof BaggageSpanProcessor)!;
    const predicate = (baggageProcessor as BaggageSpanProcessor)['_keyPredicate'].bind(baggageProcessor);

    expect(predicate('any.key')).toBeFalsy();

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS;
  });

  it('SessionIdAlwaysAddedWhenAgentObservabilityEnabledTest', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

    // Without custom baggage keys
    delete process.env.OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS;
    let spanProcessorsToTest: SpanProcessor[] = [];
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, emptyResource());
    let baggageProcessor = spanProcessorsToTest.find(p => p instanceof BaggageSpanProcessor)!;
    let predicate = (baggageProcessor as BaggageSpanProcessor)['_keyPredicate'].bind(baggageProcessor);
    expect(predicate('session.id')).toBeTruthy();

    // With custom baggage keys
    process.env.OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS = 'custom.key';
    spanProcessorsToTest = [];
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, emptyResource());
    baggageProcessor = spanProcessorsToTest.find(p => p instanceof BaggageSpanProcessor)!;
    predicate = (baggageProcessor as BaggageSpanProcessor)['_keyPredicate'].bind(baggageProcessor);
    expect(predicate('session.id')).toBeTruthy();
    expect(predicate('custom.key')).toBeTruthy();

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS;
  });

  it('ApplicationSignalsExporterProviderTest', () => {
    const DEFAULT_OTEL_EXPORTER_OTLP_PROTOCOL = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL;

    // Check default protocol - HTTP, as specified by aws-distro-opentelemetry-node-autoinstrumentation's register.ts.
    let exporter: PushMetricExporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPHttpOTLPMetricExporter);
    expect('http://localhost:4316/v1/metrics').toEqual(
      (exporter as any)._delegate._transport._transport._parameters.url
    );

    // Overwrite protocol to gRPC.
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPGrpcOTLPMetricExporter);
    expect('localhost:4315').toEqual((exporter as any)._delegate._transport._parameters.address);

    // Overwrite protocol back to HTTP.
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPHttpOTLPMetricExporter);
    expect('http://localhost:4316/v1/metrics').toEqual(
      (exporter as any)._delegate._transport._transport._parameters.url
    );

    // If for some reason, the env var is undefined (it shouldn't), overwrite protocol to gRPC.
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPGrpcOTLPMetricExporter);
    expect('localhost:4315').toEqual((exporter as any)._delegate._transport._parameters.address);

    // Expect invalid protocol to throw error.
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'invalid_protocol';
    expect(() => ApplicationSignalsExporterProvider.Instance.createExporter()).toThrow();

    // Cleanup
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = DEFAULT_OTEL_EXPORTER_OTLP_PROTOCOL;

    // Repeat tests using OTEL_EXPORTER_OTLP_METRICS_PROTOCOL environment variable instead

    // Check default protocol - HTTP, as specified by aws-distro-opentelemetry-node-autoinstrumentation's register.ts.
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPHttpOTLPMetricExporter);
    expect('http://localhost:4316/v1/metrics').toEqual(
      (exporter as any)._delegate._transport._transport._parameters.url
    );

    // Overwrite protocol to gRPC.
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'grpc';
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPGrpcOTLPMetricExporter);
    expect('localhost:4315').toEqual((exporter as any)._delegate._transport._parameters.address);

    // Overwrite protocol back to HTTP.
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'http/protobuf';
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPHttpOTLPMetricExporter);
    expect('http://localhost:4316/v1/metrics').toEqual(
      (exporter as any)._delegate._transport._transport._parameters.url
    );

    // Expect invalid protocol to throw error.
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'invalid_protocol';
    expect(() => ApplicationSignalsExporterProvider.Instance.createExporter()).toThrow();

    // Test custom URLs via OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT
    process.env.OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT = 'http://my_custom_endpoint';

    // Overwrite protocol to gRPC, export to url "my_custom_endpoint"
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'grpc';
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPGrpcOTLPMetricExporter);
    expect('my_custom_endpoint').toEqual((exporter as any)._delegate._transport._parameters.address);

    // Overwrite protocol back to HTTP, export to url "http://my_custom_endpoint"
    // OTel 2.x normalizes URLs to include trailing slash
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'http/protobuf';
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPHttpOTLPMetricExporter);
    expect('http://my_custom_endpoint/').toEqual((exporter as any)._delegate._transport._transport._parameters.url);

    // Cleanup
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL;
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT;
  });

  it('tests getSamplerProbabilityFromEnv() ratio out of bounds', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio';
    process.env.OTEL_TRACES_SAMPLER_ARG = '105';
    awsOtelConfigurator = new AwsOpentelemetryConfigurator([]);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.OTEL_TRACES_SAMPLER_ARG;
  });

  it('tests getSamplerProbabilityFromEnv() ratio not a number', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio';
    process.env.OTEL_TRACES_SAMPLER_ARG = 'abc';
    awsOtelConfigurator = new AwsOpentelemetryConfigurator([]);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.OTEL_TRACES_SAMPLER_ARG;
  });

  it('tests Span Exporter on Lambda with ApplicationSignals enabled', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'TestFunction';
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    const mockExporter: SpanExporter = sinon.createStubInstance(OTLPUdpSpanExporter);
    const customizedExporter: SpanExporter = AwsSpanProcessorProvider.customizeSpanExporter(
      mockExporter,
      emptyResource()
    );
    // should return UDP exporter for Lambda with AppSignals enabled
    expect((customizedExporter as any).delegate).toBeInstanceOf(OTLPUdpSpanExporter);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  it('tests Span Exporter on Lambda with ApplicationSignals disabled', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'TestFunction';
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'False';
    const mockExporter: SpanExporter = sinon.createStubInstance(AwsMetricAttributesSpanExporter);
    const customizedExporter: SpanExporter = AwsSpanProcessorProvider.customizeSpanExporter(
      mockExporter,
      emptyResource()
    );
    // should still return AwsMetricAttributesSpanExporter for Lambda if AppSignals disabled
    expect(mockExporter).toEqual(customizedExporter);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  it('tests configureOTLP on Lambda with ApplicationSignals enabled', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'TestFunction';
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    process.env.OTEL_TRACES_EXPORTER = 'otlp';
    process.env.AWS_XRAY_DAEMON_ADDRESS = 'www.test.com:2222';
    const spanExporter: SpanExporter = AwsSpanProcessorProvider.configureOtlp();
    expect(spanExporter).toBeInstanceOf(OTLPUdpSpanExporter);
    expect((spanExporter as OTLPUdpSpanExporter)['_endpoint']).toBe('www.test.com:2222');
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.AWS_XRAY_DAEMON_ADDRESS;
  });

  it('tests configureOTLP on Lambda with ApplicationSignals False', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'TestFunction';
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'False';
    process.env.OTEL_TRACES_EXPORTER = 'otlp';
    process.env.AWS_XRAY_DAEMON_ADDRESS = 'www.test.com:2222';
    const spanExporter: SpanExporter = AwsSpanProcessorProvider.configureOtlp();
    expect(spanExporter).toBeInstanceOf(OTLPUdpSpanExporter);
    expect((spanExporter as OTLPUdpSpanExporter)['_endpoint']).toBe('www.test.com:2222');
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.AWS_XRAY_DAEMON_ADDRESS;
  });

  it('Tests that OTLP exporter from the configurator is UDPExporter when Application Signals is disabled on Lambda', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'TestFunction';
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'False';
    process.env.OTEL_TRACES_EXPORTER = 'otlp';
    process.env.AWS_XRAY_DAEMON_ADDRESS = 'www.test.com:2222';

    const config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.spanProcessors as any)[0]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    expect((config.spanProcessors as any)[1]).toBeInstanceOf(BatchSpanProcessor);
    expect((config.spanProcessors as any)[1]._exporter).toBeInstanceOf(OTLPUdpSpanExporter);
    expect((config.spanProcessors as any)[1]._exporter._endpoint).toBe('www.test.com:2222');
    expect((config.spanProcessors as any)[2]).toBeInstanceOf(BaggageSpanProcessor);
    expect(config.spanProcessors?.length).toEqual(3);

    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.AWS_XRAY_DAEMON_ADDRESS;
  });

  it('Test CustomizeSpanProcessors for Lambda', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'TestFunction';
    const spanProcessors: SpanProcessor[] = [];
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, emptyResource());
    expect(spanProcessors.length).toEqual(4);
    expect(spanProcessors[0]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    expect(spanProcessors[1]).toBeInstanceOf(BaggageSpanProcessor);
    expect(spanProcessors[2]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect(spanProcessors[3]).toBeInstanceOf(AwsBatchUnsampledSpanProcessor);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  function validateConfiguratorEnviron() {
    // Set by register.ts
    expect(process.env).toHaveProperty('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf');
    expect(process.env).toHaveProperty('OTEL_PROPAGATORS', 'baggage,xray,tracecontext');

    // Not set
    expect(process.env).not.toHaveProperty('OTEL_TRACES_SAMPLER');
    expect(process.env).not.toHaveProperty('OTEL_TRACES_SAMPLER_ARG');
    expect(process.env).not.toHaveProperty('OTEL_TRACES_EXPORTER');
    expect(process.env).not.toHaveProperty('OTEL_METRICS_EXPORTER');
  }

  it('OtelTracesSamplerInputValidationTest', () => {
    let config;

    // Test that the samplers that should exist, do exist
    process.env.OTEL_TRACES_SAMPLER = 'always_off';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.sampler).toBeInstanceOf(AlwaysOffSampler);

    process.env.OTEL_TRACES_SAMPLER = 'always_on';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.sampler).toBeInstanceOf(AlwaysOnSampler);

    process.env.OTEL_TRACES_SAMPLER = 'parentbased_always_off';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.sampler).toBeInstanceOf(ParentBasedSampler);

    process.env.OTEL_TRACES_SAMPLER = 'parentbased_always_on';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.sampler).toBeInstanceOf(ParentBasedSampler);

    process.env.OTEL_TRACES_SAMPLER = 'parentbased_traceidratio';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.sampler).toBeInstanceOf(ParentBasedSampler);

    // Test invalid and out-of-bound cases for traceidratio sampler
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.sampler).toBeInstanceOf(TraceIdRatioBasedSampler);
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.5';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.sampler as any)._ratio).toEqual(0.5);
    process.env.OTEL_TRACES_SAMPLER_ARG = '2';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.sampler as any)._ratio).toEqual(1);
    process.env.OTEL_TRACES_SAMPLER_ARG = '-3';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.sampler as any)._ratio).toEqual(1);
    process.env.OTEL_TRACES_SAMPLER_ARG = 'abc';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.sampler as any)._ratio).toEqual(1);

    // In-depth testing for 'xray' sampler arguments can be found in test case 'ImportXRaySamplerWhenSamplerArgsSet'
    process.env.OTEL_TRACES_SAMPLER = 'xray';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.sampler).toBeInstanceOf(AwsXRayRemoteSampler);

    // Invalid sampler cases
    process.env.OTEL_TRACES_SAMPLER = 'invalid_sampler';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.sampler).toBeInstanceOf(AlwaysOnSampler);

    process.env.OTEL_TRACES_SAMPLER = '123';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.sampler).toBeInstanceOf(AlwaysOnSampler);

    // Cleanup
    delete process.env.OTEL_TRACES_SAMPLER;
  });

  it('OtelTraceExporterInputValidationTest', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    let config;

    // Default scenario where no trace exporter is specified
    process.env.OTEL_TRACES_EXPORTER = 'none';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.spanProcessors as any)[0]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    expect((config.spanProcessors as any)[1]).toBeInstanceOf(BaggageSpanProcessor);
    expect((config.spanProcessors as any)[2]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect((config.spanProcessors as any)[3]).toBeInstanceOf(AwsSpanMetricsProcessor);
    expect(config.spanProcessors?.length).toEqual(4);

    // Scenario where otlp trace exporter is specified, adds one more exporter compared to default case
    process.env.OTEL_TRACES_EXPORTER = 'otlp';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.spanProcessors as any)[0]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    expect((config.spanProcessors as any)[1]._exporter.delegate).toBeInstanceOf(OTLPProtoTraceExporter);
    expect((config.spanProcessors as any)[2]).toBeInstanceOf(BaggageSpanProcessor);
    expect((config.spanProcessors as any)[3]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect((config.spanProcessors as any)[4]).toBeInstanceOf(AwsSpanMetricsProcessor);
    expect(config.spanProcessors?.length).toEqual(5);

    // Specify invalid exporter, same result as default scenario where no trace exporter is specified
    process.env.OTEL_TRACES_EXPORTER = 'invalid_exporter_name';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.spanProcessors as any)[0]).toBeInstanceOf(AttributeRedactingSpanProcessor);
    expect((config.spanProcessors as any)[1]).toBeInstanceOf(BaggageSpanProcessor);
    expect((config.spanProcessors as any)[2]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect((config.spanProcessors as any)[3]).toBeInstanceOf(AwsSpanMetricsProcessor);
    expect(config.spanProcessors?.length).toEqual(4);

    // Cleanup
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.OTEL_TRACES_EXPORTER;
  });

  it('OtelLogExporterInputValidationTest', () => {
    let config;

    // Default scenario where no log exporter is specified
    process.env.OTEL_LOGS_EXPORTER = 'none';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.logRecordProcessors?.length).toEqual(0);

    // Scenario where otlp log exporter is specified
    process.env.OTEL_LOGS_EXPORTER = 'otlp';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.logRecordProcessors?.length).toEqual(1);
    expect((config.logRecordProcessors as any)[0]._exporter).toBeInstanceOf(OTLPProtoLogExporter);

    // Specify invalid exporter, same result as default scenario
    process.env.OTEL_LOGS_EXPORTER = 'invalid_exporter_name';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.logRecordProcessors?.length).toEqual(0);

    // Test console exporter
    process.env.OTEL_LOGS_EXPORTER = 'console';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.logRecordProcessors?.length).toEqual(1);
    expect((config.logRecordProcessors as any)[0]._exporter).toBeInstanceOf(ConsoleLogRecordExporter);

    // Test AWS OTLP logs endpoint uses OTLPAwsLogExporter
    process.env.OTEL_LOGS_EXPORTER = 'otlp';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'https://logs.us-east-1.amazonaws.com/v1/logs';
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-aws-log-group=my-group,x-aws-log-stream=my-stream';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.logRecordProcessors?.length).toEqual(1);
    expect((config.logRecordProcessors as any)[0]._exporter).toBeInstanceOf(OTLPAwsLogExporter);

    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

    // Test Agent Observability for AWS OTLP logs endpoint uses OTLPAwsLogExporter and AwsCloudWatchOtlpBatchLogRecordProcessor
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(config.logRecordProcessors?.length).toEqual(1);
    expect(config.logRecordProcessors![0]).toBeInstanceOf(AwsCloudWatchOtlpBatchLogRecordProcessor);
    expect((config.logRecordProcessors as any)[0]._exporter).toBeInstanceOf(OTLPAwsLogExporter);

    // Cleanup
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
  });

  it('ResourceDetectorInputValidationTest', () => {
    let config;
    process.env.OTEL_SERVICE_NAME = 'test_service_name';

    // OTel 2.x: defaultResource() includes additional SDK attributes, so we check for
    // the presence of expected attributes rather than exact count
    process.env.OTEL_NODE_RESOURCE_DETECTORS = 'container';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.resource as any).attributes['service.name']).toEqual('test_service_name');
    expect((config.resource as any).attributes['telemetry.auto.version'].endsWith('-aws')).toBeTruthy();

    // Still expected attributes detected given invalid resource detectors
    process.env.OTEL_NODE_RESOURCE_DETECTORS = 'invalid_detector_1,invalid_detector_2';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.resource as any).attributes['service.name']).toEqual('test_service_name');
    expect((config.resource as any).attributes['telemetry.auto.version'].endsWith('-aws')).toBeTruthy();

    // Still expected attributes detected given mix of valid and invalid resource detectors
    process.env.OTEL_NODE_RESOURCE_DETECTORS = 'container,invalid_detector_1,invalid_detector_2';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.resource as any).attributes['service.name']).toEqual('test_service_name');
    expect((config.resource as any).attributes['telemetry.auto.version'].endsWith('-aws')).toBeTruthy();

    // Cleanup
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
  });

  it('DefaultServiceNameTest', () => {
    // Ensure OTEL_SERVICE_NAME is not set
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;

    const config = new AwsOpentelemetryConfigurator([]).configure();
    const serviceName = (config.resource as any).attributes['service.name'];

    // Verify service.name is present and follows the default pattern (unknown_service:<process>)
    expect(serviceName).toBeDefined();
    expect(serviceName.startsWith('unknown_service:')).toBe(true);
  });

  describe('AwsSpanProcessorProviderTest', () => {
    it('configureOtlp', () => {
      let spanExporter;

      // Test span exporter configurations via valid environment variables
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
      spanExporter = AwsSpanProcessorProvider.configureOtlp();
      expect(spanExporter).toBeInstanceOf(OTLPProtoTraceExporter);

      process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'grpc';
      spanExporter = AwsSpanProcessorProvider.configureOtlp();
      expect(spanExporter).toBeInstanceOf(OTLPGrpcTraceExporter);

      process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'http/json';
      spanExporter = AwsSpanProcessorProvider.configureOtlp();
      expect(spanExporter).toBeInstanceOf(OTLPHttpTraceExporter);

      process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'http/protobuf';
      spanExporter = AwsSpanProcessorProvider.configureOtlp();
      expect(spanExporter).toBeInstanceOf(OTLPProtoTraceExporter);

      process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'udp';
      spanExporter = AwsSpanProcessorProvider.configureOtlp();
      expect(spanExporter).toBeInstanceOf(OTLPUdpSpanExporter);

      // Test that a default span exporter is configured via invalid environment variable
      process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'invalid_protocol';
      spanExporter = AwsSpanProcessorProvider.configureOtlp();
      expect(spanExporter).toBeInstanceOf(OTLPProtoTraceExporter);

      // Cleanup
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    });

    it('configureOtlp - OtlpAwsSpanExporter', () => {
      const OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';
      const OTEL_TRACES_EXPORTER = 'OTEL_TRACES_EXPORTER';

      const tracesGoodEndpoints = [
        'https://xray.us-east-1.amazonaws.com/v1/traces',
        'https://XRAY.US-EAST-1.AMAZONAWS.COM/V1/TRACES',
        'https://xray.us-east-1.amazonaws.com/v1/traces',
        'https://XRAY.US-EAST-1.amazonaws.com/v1/traces',
        'https://xray.US-EAST-1.AMAZONAWS.com/v1/traces',
        'https://Xray.Us-East-1.amazonaws.com/v1/traces',
        'https://xRAY.us-EAST-1.amazonaws.com/v1/traces',
        'https://XRAY.us-EAST-1.AMAZONAWS.com/v1/TRACES',
        'https://xray.US-EAST-1.amazonaws.com/V1/Traces',
        'https://xray.us-east-1.AMAZONAWS.COM/v1/traces',
        'https://XrAy.Us-EaSt-1.AmAzOnAwS.cOm/V1/TrAcEs',
        'https://xray.US-EAST-1.amazonaws.com/v1/traces',
        'https://xray.us-east-1.amazonaws.com/V1/TRACES',
        'https://XRAY.US-EAST-1.AMAZONAWS.COM/v1/traces',
        'https://xray.us-east-1.AMAZONAWS.COM/V1/traces',
        // AWS China partition
        'https://xray.cn-north-1.amazonaws.com.cn/v1/traces',
        'https://xray.cn-northwest-1.amazonaws.com.cn/v1/traces',
        'https://XRAY.CN-NORTH-1.AMAZONAWS.COM.CN/V1/TRACES',
      ];

      const tracesBadEndpoints = [
        'http://localhost:4318/v1/traces',
        // China lookalikes: the optional .cn group must not loosen the anchored pattern
        'https://xray.cn-north-1.amazonaws.cn/v1/traces',
        'https://xray.cn-north-1.amazonaws.com.cn.example.com/v1/traces',
        'https://xray.cn-north-1.amazonaws.com.c/v1/traces',
        'https://xray.cn-north-1.amazonaws.comcn/v1/traces',
        'http://xray.us-east-1.amazonaws.com/v1/traces',
        'ftp://xray.us-east-1.amazonaws.com/v1/traces',
        'https://ray.us-east-1.amazonaws.com/v1/traces',
        'https://xra.us-east-1.amazonaws.com/v1/traces',
        'https://x-ray.us-east-1.amazonaws.com/v1/traces',
        'https://xray.amazonaws.com/v1/traces',
        'https://xray.us-east-1.amazon.com/v1/traces',
        'https://xray.us-east-1.aws.com/v1/traces',
        'https://xray.us_east_1.amazonaws.com/v1/traces',
        'https://xray.us.east.1.amazonaws.com/v1/traces',
        'https://xray..amazonaws.com/v1/traces',
        'https://xray.us-east-1.amazonaws.com/traces',
        'https://xray.us-east-1.amazonaws.com/v2/traces',
        'https://xray.us-east-1.amazonaws.com/v1/trace',
        'https://xray.us-east-1.amazonaws.com/v1/traces/',
        'https://xray.us-east-1.amazonaws.com//v1/traces',
        'https://xray.us-east-1.amazonaws.com/v1//traces',
        'https://xray.us-east-1.amazonaws.com/v1/traces?param=value',
        'https://xray.us-east-1.amazonaws.com/v1/traces#fragment',
        'https://xray.us-east-1.amazonaws.com:443/v1/traces',
        'https:/xray.us-east-1.amazonaws.com/v1/traces',
        'https:://xray.us-east-1.amazonaws.com/v1/traces',
      ];

      const goodConfigs = [];
      const badConfigs = [];

      // good configurations
      for (const endpoint of tracesGoodEndpoints) {
        const config = {
          [OTEL_TRACES_EXPORTER]: 'otlp',
          [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: endpoint,
        };
        goodConfigs.push(config);
      }

      // bad configurations with bad endpoints
      for (const endpoint of tracesBadEndpoints) {
        const config = {
          [OTEL_TRACES_EXPORTER]: 'otlp',
          [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: endpoint,
        };
        badConfigs.push(config);
      }

      // Test good configurations
      for (const config of goodConfigs) {
        customizeExporterTest(config, () => [AwsSpanProcessorProvider.configureOtlp()], OTLPAwsSpanExporter);
      }

      // Test bad configurations
      for (const config of badConfigs) {
        customizeExporterTest(config, () => [AwsSpanProcessorProvider.configureOtlp()], OTLPProtoTraceExporter);
      }
    });
  });

  describe('AwsLoggerProcessorProvider', () => {
    it('getlogRecordProcessors', () => {
      process.env.OTEL_LOGS_EXPORTER = 'otlp';
      let logRecordProcessors = AwsLoggerProcessorProvider.getlogRecordProcessors();

      expect(logRecordProcessors).toHaveLength(1);
      expect(logRecordProcessors[0]).toBeInstanceOf(BatchLogRecordProcessor);

      process.env.OTEL_LOGS_EXPORTER = 'console';
      logRecordProcessors = AwsLoggerProcessorProvider.getlogRecordProcessors();

      expect(logRecordProcessors).toHaveLength(1);
      expect(logRecordProcessors[0]).toBeInstanceOf(SimpleLogRecordProcessor);

      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
      process.env.OTEL_LOGS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'https://logs.us-east-1.amazonaws.com/v1/logs';
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-aws-log-group=my-group,x-aws-log-stream=my-stream';

      logRecordProcessors = AwsLoggerProcessorProvider.getlogRecordProcessors();

      expect(logRecordProcessors).toHaveLength(1);
      expect(logRecordProcessors[0]).toBeInstanceOf(AwsCloudWatchOtlpBatchLogRecordProcessor);

      delete process.env.OTEL_LOGS_EXPORTER;
      delete process.env.AGENT_OBSERVABILITY_ENABLED;
      delete process.env.OTEL_LOGS_EXPORTER;
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
    });

    it('configureLogExportersFromEnv', () => {
      let logsExporter: LogRecordExporter[];

      delete process.env.OTEL_LOGS_EXPORTER;
      // Test span exporter configurations via valid environment variables
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL;
      logsExporter = AwsLoggerProcessorProvider.configureLogExportersFromEnv();
      expect(logsExporter).toHaveLength(1);
      expect(logsExporter[0]).toBeInstanceOf(OTLPProtoLogExporter);

      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/protobuf';
      logsExporter = AwsLoggerProcessorProvider.configureLogExportersFromEnv();
      expect(logsExporter).toHaveLength(1);
      expect(logsExporter[0]).toBeInstanceOf(OTLPProtoLogExporter);

      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'grpc';
      logsExporter = AwsLoggerProcessorProvider.configureLogExportersFromEnv();
      expect(logsExporter).toHaveLength(1);
      expect(logsExporter[0]).toBeInstanceOf(OTLPGrpcLogExporter);

      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json';
      logsExporter = AwsLoggerProcessorProvider.configureLogExportersFromEnv();
      expect(logsExporter).toHaveLength(1);
      expect(logsExporter[0]).toBeInstanceOf(OTLPHttpLogExporter);

      // Test that a default span exporter is configured via invalid environment variable
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'invalid_protocol';
      logsExporter = AwsLoggerProcessorProvider.configureLogExportersFromEnv();
      expect(logsExporter).toHaveLength(1);
      expect(logsExporter[0]).toBeInstanceOf(OTLPProtoLogExporter);

      // Cleanup
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL;
    });

    it('configureLogExportersFromEnv - OtlpAwsLogsExporter', () => {
      const OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT';
      const OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'OTEL_EXPORTER_OTLP_LOGS_HEADERS';
      const OTEL_LOGS_EXPORTER = 'OTEL_LOGS_EXPORTER';

      const logsGoodEndpoints = [
        'https://logs.us-east-1.amazonaws.com/v1/logs',
        'https://LOGS.US-EAST-1.AMAZONAWS.COM/V1/LOGS',
        'https://logs.us-east-1.amazonaws.com/v1/logs',
        'https://LOGS.US-EAST-1.amazonaws.com/v1/logs',
        'https://logs.US-EAST-1.AMAZONAWS.com/v1/logs',
        'https://Logs.Us-East-1.amazonaws.com/v1/logs',
        'https://lOGS.us-EAST-1.amazonaws.com/v1/logs',
        'https://LOGS.us-EAST-1.AMAZONAWS.com/v1/LOGS',
        'https://logs.US-EAST-1.amazonaws.com/V1/Logs',
        'https://logs.us-east-1.AMAZONAWS.COM/v1/logs',
        'https://LoGs.Us-EaSt-1.AmAzOnAwS.cOm/V1/LoGs',
        'https://logs.US-EAST-1.amazonaws.com/v1/logs',
        'https://logs.us-east-1.amazonaws.com/V1/LOGS',
        'https://LOGS.US-EAST-1.AMAZONAWS.COM/v1/logs',
        'https://logs.us-east-1.AMAZONAWS.COM/V1/logs',
        // AWS China partition
        'https://logs.cn-north-1.amazonaws.com.cn/v1/logs',
        'https://logs.cn-northwest-1.amazonaws.com.cn/v1/logs',
        'https://LOGS.CN-NORTH-1.AMAZONAWS.COM.CN/V1/LOGS',
      ];

      const logsBadEndpoints = [
        'http://localhost:4318/v1/logs',
        // China lookalikes: the optional .cn group must not loosen the anchored pattern
        'https://logs.cn-north-1.amazonaws.cn/v1/logs',
        'https://logs.cn-north-1.amazonaws.com.cn.example.com/v1/logs',
        'https://logs.cn-north-1.amazonaws.com.c/v1/logs',
        'https://logs.cn-north-1.amazonaws.comcn/v1/logs',
        'http://logs.us-east-1.amazonaws.com/v1/logs',
        'ftp://logs.us-east-1.amazonaws.com/v1/logs',
        'https://log.us-east-1.amazonaws.com/v1/logs',
        'https://logging.us-east-1.amazonaws.com/v1/logs',
        'https://cloud-logs.us-east-1.amazonaws.com/v1/logs',
        'https://logs.amazonaws.com/v1/logs',
        'https://logs.us-east-1.amazon.com/v1/logs',
        'https://logs.us-east-1.aws.com/v1/logs',
        'https://logs.us_east_1.amazonaws.com/v1/logs',
        'https://logs.us.east.1.amazonaws.com/v1/logs',
        'https://logs..amazonaws.com/v1/logs',
        'https://logs.us-east-1.amazonaws.com/logs',
        'https://logs.us-east-1.amazonaws.com/v2/logs',
        'https://logs.us-east-1.amazonaws.com/v1/log',
        'https://logs.us-east-1.amazonaws.com/v1/logs/',
        'https://logs.us-east-1.amazonaws.com//v1/logs',
        'https://logs.us-east-1.amazonaws.com/v1//logs',
        'https://logs.us-east-1.amazonaws.com/v1/logs?param=value',
        'https://logs.us-east-1.amazonaws.com/v1/logs#fragment',
        'https://logs.us-east-1.amazonaws.com:443/v1/logs',
        'https:/logs.us-east-1.amazonaws.com/v1/logs',
        'https:://logs.us-east-1.amazonaws.com/v1/logs',
        'https://logs.us-east-1.amazonaws.com/v1/logging',
        'https://logs.us-east-1.amazonaws.com/v1/cloudwatchlogs',
        'https://logs.us-east-1.amazonaws.com/v1/cwlogs',
      ];

      const logsBadHeaders = [
        'x-aws-log-group=,x-aws-log-stream=test',
        'x-aws-log-group=test,x-aws-log-group=test',
        'x-aws-log-stream=test,x-aws-log-stream=test',
        'x-aws-log-stream=test',
        'x-aws-log-group=test',
        '',
      ];

      const goodConfigs = [];
      const badConfigs = [];

      // good configurations
      for (const endpoint of logsGoodEndpoints) {
        const config = {
          [OTEL_LOGS_EXPORTER]: 'otlp',
          [OTEL_EXPORTER_OTLP_LOGS_ENDPOINT]: endpoint,
          [OTEL_EXPORTER_OTLP_LOGS_HEADERS]: 'x-aws-log-group=test,x-aws-log-stream=test',
        };
        goodConfigs.push(config);
      }

      // Cbad configurations with bad endpoints
      for (const endpoint of logsBadEndpoints) {
        const config = {
          [OTEL_LOGS_EXPORTER]: 'otlp',
          [OTEL_EXPORTER_OTLP_LOGS_ENDPOINT]: endpoint,
          [OTEL_EXPORTER_OTLP_LOGS_HEADERS]: 'x-aws-log-group=test,x-aws-log-stream=test',
        };
        badConfigs.push(config);
      }

      // bad configurations with bad headers
      for (const headers of logsBadHeaders) {
        const config = {
          [OTEL_LOGS_EXPORTER]: 'otlp',
          [OTEL_EXPORTER_OTLP_LOGS_ENDPOINT]: 'https://logs.us-east-1.amazonaws.com/v1/logs',
          [OTEL_EXPORTER_OTLP_LOGS_HEADERS]: headers,
        };
        badConfigs.push(config);
      }

      // Test good configurations
      for (const config of goodConfigs) {
        customizeExporterTest(
          config,
          () => AwsLoggerProcessorProvider.configureLogExportersFromEnv(),
          OTLPAwsLogExporter
        );
      }

      // Test bad configurations
      for (const config of badConfigs) {
        customizeExporterTest(
          config,
          () => AwsLoggerProcessorProvider.configureLogExportersFromEnv(),
          OTLPProtoLogExporter
        );
      }
    });
  });

  it('ExportUnsampledSpanForAgentObservabilityTest', () => {
    const spanProcessorsToTest: SpanProcessor[] = [];

    // Test with agent observability disabled
    AwsOpentelemetryConfigurator.exportUnsampledSpanForAgentObservability(spanProcessorsToTest, emptyResource());
    expect(spanProcessorsToTest).toEqual([]);

    // Test with agent observability enabled
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://xray.us-east-1.amazonaws.com/v1/traces';

    AwsOpentelemetryConfigurator.exportUnsampledSpanForAgentObservability(spanProcessorsToTest, emptyResource());
    expect(spanProcessorsToTest.length).toEqual(1);

    const processor = spanProcessorsToTest[0];
    expect(processor).toBeInstanceOf(AwsBatchUnsampledSpanProcessor);

    // Cleanup
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

    // Test fallback to OTEL_EXPORTER_OTLP_ENDPOINT
    const fallbackProcessors: SpanProcessor[] = [];
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';

    AwsOpentelemetryConfigurator.exportUnsampledSpanForAgentObservability(fallbackProcessors, emptyResource());
    expect(fallbackProcessors.length).toEqual(1);
    expect(fallbackProcessors[0]).toBeInstanceOf(AwsBatchUnsampledSpanProcessor);
    const fallbackExporter = (fallbackProcessors[0] as AwsBatchUnsampledSpanProcessor)['_exporter'];
    expect(fallbackExporter['endpoint']).toEqual('http://localhost:4318/v1/traces');

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    // Test AWS endpoint via base OTEL_EXPORTER_OTLP_ENDPOINT fallback
    const awsFallbackProcessors: SpanProcessor[] = [];
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://xray.us-west-2.amazonaws.com';

    AwsOpentelemetryConfigurator.exportUnsampledSpanForAgentObservability(awsFallbackProcessors, emptyResource());
    expect(awsFallbackProcessors.length).toEqual(1);
    expect(awsFallbackProcessors[0]).toBeInstanceOf(AwsBatchUnsampledSpanProcessor);
    const awsFallbackExporter = (awsFallbackProcessors[0] as AwsBatchUnsampledSpanProcessor)['_exporter'];
    expect(awsFallbackExporter).toBeInstanceOf(OTLPAwsSpanExporter);
    expect(awsFallbackExporter['endpoint']).toEqual('https://xray.us-west-2.amazonaws.com/v1/traces');

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    // Test precedence: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT wins over OTEL_EXPORTER_OTLP_ENDPOINT
    const precedenceProcessors: SpanProcessor[] = [];
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://xray.us-east-1.amazonaws.com/v1/traces';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';

    AwsOpentelemetryConfigurator.exportUnsampledSpanForAgentObservability(precedenceProcessors, emptyResource());
    expect(precedenceProcessors.length).toEqual(1);
    expect(precedenceProcessors[0]).toBeInstanceOf(AwsBatchUnsampledSpanProcessor);
    const precedenceExporter = (precedenceProcessors[0] as AwsBatchUnsampledSpanProcessor)['_exporter'];
    expect(precedenceExporter).toBeInstanceOf(OTLPAwsSpanExporter);
    expect(precedenceExporter['endpoint']).toEqual('https://xray.us-east-1.amazonaws.com/v1/traces');

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it('ExportUnsampledSpanForAgentObservabilityUsesOtlpAwsSpanExporterTest', () => {
    const spanProcessorsToTest: SpanProcessor[] = [];

    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://xray.us-east-1.amazonaws.com/v1/traces';

    AwsOpentelemetryConfigurator.exportUnsampledSpanForAgentObservability(spanProcessorsToTest, emptyResource());

    // Verify AwsBatchUnsampledSpanProcessor was created with the AWS exporter
    expect(spanProcessorsToTest[0]).toBeInstanceOf(AwsBatchUnsampledSpanProcessor);
    const otlpAwsSpanExporter = (spanProcessorsToTest[0] as AwsBatchUnsampledSpanProcessor)['_exporter'];

    // Verify OTLPAwsSpanExporter was created with correct parameters
    expect(otlpAwsSpanExporter).toBeInstanceOf(OTLPAwsSpanExporter);
    expect(otlpAwsSpanExporter['endpoint']).toEqual('https://xray.us-east-1.amazonaws.com/v1/traces');

    // Cleanup environment variables
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  });

  it('CustomizeSpanProcessorsCallsExportUnsampledSpanTest', () => {
    const spanProcessorsToTest: SpanProcessor[] = [];

    // Create spy for exportUnsampledSpanForAgentObservability
    const exportUnsampledSpanSpy = sinon.spy(AwsOpentelemetryConfigurator, 'exportUnsampledSpanForAgentObservability');

    try {
      // Test that function is NOT called when agent observability is disabled
      delete process.env.AGENT_OBSERVABILITY_ENABLED;
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, emptyResource());
      expect(exportUnsampledSpanSpy.called).toBeFalsy();

      // Test that function is called when agent observability is enabled
      exportUnsampledSpanSpy.resetHistory();
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, emptyResource());
      expect(exportUnsampledSpanSpy.calledOnce).toBeTruthy();
      expect(exportUnsampledSpanSpy.calledWith(spanProcessorsToTest, emptyResource())).toBeTruthy();
    } finally {
      // Restore original implementation
      exportUnsampledSpanSpy.restore();

      // Cleanup
      delete process.env.AGENT_OBSERVABILITY_ENABLED;
    }
  });

  it('testCheckEmfExporterEnabled', () => {
    process.env.OTEL_METRICS_EXPORTER = 'first,awsemf,third';
    checkEmfExporterEnabled();
    expect(process.env.OTEL_METRICS_EXPORTER).toEqual('first,third');
  });

  it('testIsAwsOtlpEndpoint', () => {
    expect(isAwsOtlpEndpoint('https://xray.us-east-1.amazonaws.com/v1/traces', 'xray')).toBeTruthy();
    expect(isAwsOtlpEndpoint('https://lambda.us-east-1.amazonaws.com/v1/traces', 'xray')).toBeFalsy();
    expect(isAwsOtlpEndpoint('https://xray.us-east-1.amazonaws.com/v1/logs', 'xray')).toBeFalsy();
    expect(isAwsOtlpEndpoint('https://logs.us-east-1.amazonaws.com/v1/logs', 'logs')).toBeTruthy();
    expect(isAwsOtlpEndpoint('https://lambda.us-east-1.amazonaws.com/v1/logs', 'logs')).toBeFalsy();

    // AWS China partition
    expect(isAwsOtlpEndpoint('https://xray.cn-north-1.amazonaws.com.cn/v1/traces', 'xray')).toBeTruthy();
    expect(isAwsOtlpEndpoint('https://logs.cn-northwest-1.amazonaws.com.cn/v1/logs', 'logs')).toBeTruthy();
    // The optional .cn group must not match a lookalike host.
    expect(isAwsOtlpEndpoint('https://xray.cn-north-1.amazonaws.com.cn.example.com/v1/traces', 'xray')).toBeFalsy();
    expect(isAwsOtlpEndpoint('https://logs.cn-north-1.amazonaws.cn/v1/logs', 'logs')).toBeFalsy();

    // CloudWatch metrics
    expect(isAwsOtlpEndpoint('https://monitoring.us-east-1.amazonaws.com/v1/metrics', 'monitoring')).toBeTruthy();
    expect(isAwsOtlpEndpoint('https://monitoring.cn-north-1.amazonaws.com.cn/v1/metrics', 'monitoring')).toBeTruthy();
    expect(isAwsOtlpEndpoint('https://monitoring.us-east-1.amazonaws.com/v1/traces', 'monitoring')).toBeFalsy();
    expect(isAwsOtlpEndpoint('https://logs.us-east-1.amazonaws.com/v1/metrics', 'monitoring')).toBeFalsy();
    // The service must be matched explicitly; an unknown service never matches.
    expect(isAwsOtlpEndpoint('https://monitoring.us-east-1.amazonaws.com/v1/metrics', 'cloudwatch')).toBeFalsy();
    expect(isAwsOtlpEndpoint('https://logs.us-east-1.amazonaws.com/v1/traces', 'logs')).toBeFalsy();
  });

  it('testvalidateAndFetchLogsHeader', () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS =
      'x-aws-log-group=/test/log/group/name,x-aws-log-stream=test_log_stream_name,x-aws-metric-namespace=TEST_NAMESPACE';
    let headerSettings = validateAndFetchLogsHeader();
    expect(headerSettings).toEqual({
      logGroup: '/test/log/group/name',
      logStream: 'test_log_stream_name',
      namespace: 'TEST_NAMESPACE',
      isValid: true,
    });

    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
    headerSettings = validateAndFetchLogsHeader();
    expect(headerSettings).toEqual({
      isValid: false,
      logGroup: undefined,
      logStream: undefined,
      namespace: undefined,
    });
  });

  function customizeExporterTest(
    config: { [x: string]: string },
    executor: () => LogRecordExporter[] | SpanExporter[],
    expectedExporterType: { new (...args: any[]): any }
  ) {
    for (const key in config) {
      process.env[key] = config[key];
    }

    const result = executor();
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(expectedExporterType);

    for (const key in config) {
      delete process.env[key];
    }
  }

  it('CustomizeResourceWithoutAgentObservability', () => {
    delete process.env.AGENT_OBSERVABILITY_ENABLED;

    let resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'test-service' });
    resource = awsOtelConfigurator['customizeResource'](resource);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toEqual('test-service');
    expect(resource.attributes).not.toHaveProperty(AWS_ATTRIBUTE_KEYS.AWS_SERVICE_TYPE);
  });

  it('CustomizeResourceWithAgentObservabilityDefault', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

    let resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'test-service' });
    resource = awsOtelConfigurator['customizeResource'](resource);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toEqual('test-service');
    expect(resource.attributes[AWS_ATTRIBUTE_KEYS.AWS_SERVICE_TYPE]).toEqual('gen_ai_agent');

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
  });

  it('CustomizeResourceWithoutAgentObservability', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

    let resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'test-service',
      [AWS_ATTRIBUTE_KEYS.AWS_SERVICE_TYPE]: 'existing-agent',
    });
    resource = awsOtelConfigurator['customizeResource'](resource);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toEqual('test-service');
    expect(resource.attributes[AWS_ATTRIBUTE_KEYS.AWS_SERVICE_TYPE]).toEqual('existing-agent');

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
  });

  it('DisablesApplicationSignalsDimensionsWhenAgentObservabilityEnabled', () => {
    // Clean up env vars before test
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS;

    // Verify the env var is not set initially
    expect(process.env.OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS).toBeUndefined();

    // Enable agent observability and create a new configurator
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    new AwsOpentelemetryConfigurator([]);

    // Verify the configurator set the env var to 'false'
    expect(process.env.OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS).toEqual('false');

    // Clean up
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS;
  });

  it('DoesNotOverrideApplicationSignalsDimensionsWhenExplicitlySet', () => {
    // Clean up env vars before test
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS;

    // Set the env var explicitly before enabling agent observability
    process.env.OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS = 'true';

    // Enable agent observability and create a new configurator
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    new AwsOpentelemetryConfigurator([]);

    // Verify the configurator did NOT override the explicitly set value
    expect(process.env.OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS).toEqual('true');

    // Clean up
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS;
  });

  describe('Test createEmfExporter', () => {
    beforeEach(() => {
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    });

    afterEach(() => {
      sinon.restore();
    });

    it('Test createEmfExporter in Lambda with valid headers', () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'lambdaFunctionName';
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS =
        'x-aws-log-group=test-group,x-aws-log-stream=test-stream,x-aws-metric-namespace=test-namespace';

      const result = createEmfExporter();
      expect(result).toBeInstanceOf(AWSCloudWatchEMFExporter);
    });

    it('creates Console EMF exporter in Lambda with invalid headers', () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'lambdaFunctionName';
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-aws-metric-namespace=test-namespace';

      const result = createEmfExporter();
      expect(result).toBeInstanceOf(ConsoleEMFExporter);
    });

    it('creates Console EMF exporter in Lambda with invalid headers and no namespace defaults to "default" namespace', () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'lambdaFunctionName';
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'nothing=here';

      const result = createEmfExporter();
      expect(result).toBeInstanceOf(ConsoleEMFExporter);
      expect(result!['namespace']).toEqual('default');
    });

    it('creates CloudWatch EMF exporter in non-Lambda environment', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS =
        'x-aws-log-group=test-group,x-aws-log-stream=test-stream,x-aws-metric-namespace=test-namespace';

      const result = createEmfExporter();
      expect(result).toBeInstanceOf(AWSCloudWatchEMFExporter);
    });

    it('returns undefined when CloudWatch EMF exporter creation fails in non-Lambda environment due to invalid headers', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-aws-log-stream=test-stream';

      const result = createEmfExporter();
      expect(result).toBeUndefined();
    });
  });

  describe('Test hasExplicitAuthorizationHeader', () => {
    const ENV_VAR = 'OTEL_EXPORTER_OTLP_METRICS_HEADERS';

    afterEach(() => {
      delete process.env[ENV_VAR];
    });

    it('returns false when the variable is unset or empty', () => {
      expect(hasExplicitAuthorizationHeader(ENV_VAR)).toBeFalsy();

      process.env[ENV_VAR] = '';
      expect(hasExplicitAuthorizationHeader(ENV_VAR)).toBeFalsy();
    });

    it('returns false when no Authorization header is present', () => {
      process.env[ENV_VAR] = 'x-aws-log-group=g,x-custom=value';
      expect(hasExplicitAuthorizationHeader(ENV_VAR)).toBeFalsy();
    });

    it('detects an Authorization header regardless of case', () => {
      for (const name of ['Authorization', 'authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN']) {
        process.env[ENV_VAR] = `${name}=Bearer%20token`;
        expect(hasExplicitAuthorizationHeader(ENV_VAR)).toBeTruthy();
      }
    });

    it('detects an Authorization header alongside other headers', () => {
      process.env[ENV_VAR] = 'x-custom=value,Authorization=Bearer%20token,x-other=value';
      expect(hasExplicitAuthorizationHeader(ENV_VAR)).toBeTruthy();
    });

    it('only inspects the variable it is given', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%20global';
      expect(hasExplicitAuthorizationHeader(ENV_VAR)).toBeFalsy();
      expect(hasExplicitAuthorizationHeader('OTEL_EXPORTER_OTLP_HEADERS')).toBeTruthy();

      delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    });
  });

  describe('Test createAwsOtlpMetricExporter', () => {
    const METRICS_ENV_VARS = [
      'OTEL_METRICS_EXPORTER',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION',
      'OTEL_AWS_APPLICATION_SIGNALS_ENABLED',
    ];

    const clearEnv = () => METRICS_ENV_VARS.forEach(name => delete process.env[name]);

    beforeEach(clearEnv);
    afterEach(clearEnv);

    const metricsGoodEndpoints = [
      'https://monitoring.us-east-1.amazonaws.com/v1/metrics',
      'https://monitoring.us-west-2.amazonaws.com/v1/metrics',
      'https://MONITORING.US-EAST-1.AMAZONAWS.COM/V1/METRICS',
      'https://Monitoring.Us-East-1.amazonaws.com/v1/metrics',
      // AWS China partition
      'https://monitoring.cn-north-1.amazonaws.com.cn/v1/metrics',
      'https://monitoring.cn-northwest-1.amazonaws.com.cn/v1/metrics',
    ];

    const metricsBadEndpoints = [
      'http://localhost:4318/v1/metrics',
      'http://monitoring.us-east-1.amazonaws.com/v1/metrics',
      'https://monitor.us-east-1.amazonaws.com/v1/metrics',
      'https://cloudwatch.us-east-1.amazonaws.com/v1/metrics',
      'https://monitoring.amazonaws.com/v1/metrics',
      'https://monitoring.us-east-1.amazon.com/v1/metrics',
      'https://monitoring.us_east_1.amazonaws.com/v1/metrics',
      'https://monitoring.us-east-1.amazonaws.com/metrics',
      'https://monitoring.us-east-1.amazonaws.com/v2/metrics',
      'https://monitoring.us-east-1.amazonaws.com/v1/metric',
      'https://monitoring.us-east-1.amazonaws.com/v1/metrics/',
      'https://monitoring.us-east-1.amazonaws.com/v1/metrics?param=value',
      'https://monitoring.us-east-1.amazonaws.com:443/v1/metrics',
      // China lookalikes
      'https://monitoring.cn-north-1.amazonaws.cn/v1/metrics',
      'https://monitoring.cn-north-1.amazonaws.com.cn.example.com/v1/metrics',
    ];

    it('returns the AWS metrics exporter for recognized endpoints', () => {
      for (const endpoint of metricsGoodEndpoints) {
        clearEnv();
        process.env.OTEL_METRICS_EXPORTER = 'otlp';
        process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = endpoint;

        expect(createAwsOtlpMetricExporter()).toBeInstanceOf(OTLPAwsMetricExporter);
      }
    });

    it('leaves the upstream exporter alone for unrecognized endpoints', () => {
      for (const endpoint of metricsBadEndpoints) {
        clearEnv();
        process.env.OTEL_METRICS_EXPORTER = 'otlp';
        process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = endpoint;

        expect(createAwsOtlpMetricExporter()).toBeUndefined();
      }
    });

    it('does nothing when no metrics endpoint is configured', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';

      expect(createAwsOtlpMetricExporter()).toBeUndefined();
    });

    it('does nothing when OTEL_METRICS_EXPORTER does not include otlp', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];

      for (const value of ['none', 'console', 'awsemf']) {
        process.env.OTEL_METRICS_EXPORTER = value;
        expect(createAwsOtlpMetricExporter()).toBeUndefined();
      }
    });

    // Upstream treats an unset or empty OTEL_METRICS_EXPORTER as otlp. Missing that default meant
    // declining to sign the configuration the CloudWatch docs show - endpoint only - so upstream
    // exported unsigned and every request was rejected with 403.
    it('treats an unset or empty OTEL_METRICS_EXPORTER as otlp', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];

      delete process.env.OTEL_METRICS_EXPORTER;
      expect(createAwsOtlpMetricExporter()).toBeInstanceOf(OTLPAwsMetricExporter);

      process.env.OTEL_METRICS_EXPORTER = '';
      expect(createAwsOtlpMetricExporter()).toBeInstanceOf(OTLPAwsMetricExporter);
    });

    // An explicit "none" disables metrics. Ignoring it would publish billable custom metrics against
    // the user's stated intent.
    it('honors an explicit none even when otlp is also listed', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];

      for (const value of ['otlp,none', 'none,otlp', 'console,none,otlp']) {
        process.env.OTEL_METRICS_EXPORTER = value;
        expect(createAwsOtlpMetricExporter()).toBeUndefined();
      }
    });

    it('accepts http/protobuf, whether set for the signal or globally, and when unset', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];

      expect(createAwsOtlpMetricExporter()).toBeInstanceOf(OTLPAwsMetricExporter);

      process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'http/protobuf';
      expect(createAwsOtlpMetricExporter()).toBeInstanceOf(OTLPAwsMetricExporter);

      delete process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL;
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
      expect(createAwsOtlpMetricExporter()).toBeInstanceOf(OTLPAwsMetricExporter);
    });

    it('passes through untouched for protocols CloudWatch does not accept', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];

      for (const protocol of ['grpc', 'http/json']) {
        process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = protocol;
        expect(createAwsOtlpMetricExporter()).toBeUndefined();
      }
    });

    it('preserves bearer authentication configured for metrics', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];
      process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'Authorization=Bearer%20my-api-key';

      expect(createAwsOtlpMetricExporter()).toBeUndefined();
    });

    // Load-bearing: a global Authorization is a catch-all that may target an unrelated backend, so it
    // must not silently disable SigV4 against an AWS endpoint. This is the case that would regress if
    // the rule were ever changed to consult the global variable.
    it('still applies SigV4 when only the global Authorization header is set', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%20unrelated-backend';

      expect(createAwsOtlpMetricExporter()).toBeInstanceOf(OTLPAwsMetricExporter);
    });

    it('still applies SigV4 when signal-specific headers exist without an Authorization header', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];
      process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'x-custom=value';
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%20unrelated-backend';

      expect(createAwsOtlpMetricExporter()).toBeInstanceOf(OTLPAwsMetricExporter);
    });

    it('honors the metrics compression preference, defaulting to none', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];

      // The factory returns the PushMetricExporter interface, so narrow to the concrete class to read
      // the compression setting it was constructed with.
      expect((createAwsOtlpMetricExporter() as OTLPAwsMetricExporter)['compression']).toEqual(
        CompressionAlgorithm.NONE
      );

      process.env.OTEL_EXPORTER_OTLP_METRICS_COMPRESSION = 'gzip';
      expect((createAwsOtlpMetricExporter() as OTLPAwsMetricExporter)['compression']).toEqual(
        CompressionAlgorithm.GZIP
      );
    });

    it('still creates the exporter when Application Signals is enabled', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = metricsGoodEndpoints[0];
      process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';

      // Application Signals keeps its own pipeline; this path only warns rather than overriding it.
      expect(createAwsOtlpMetricExporter()).toBeInstanceOf(OTLPAwsMetricExporter);
    });
  });

  describe('Test metric readers for the AWS metrics path', () => {
    const METRICS_ENV_VARS = [
      'OTEL_METRICS_EXPORTER',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
      'OTEL_AWS_APPLICATION_SIGNALS_ENABLED',
      'OTEL_METRIC_EXPORT_INTERVAL',
      'OTEL_METRIC_EXPORT_TIMEOUT',
    ];

    const clearEnv = () => METRICS_ENV_VARS.forEach(name => delete process.env[name]);

    beforeEach(clearEnv);
    afterEach(clearEnv);

    it('configures a reader for the AWS metrics endpoint', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';

      const config = new AwsOpentelemetryConfigurator([]).configure();

      expect(config.metricReaders).toHaveLength(1);
    });

    it('does not take over metric readers when the endpoint is not an AWS metrics endpoint', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';

      const config = new AwsOpentelemetryConfigurator([]).configure();

      // Leaving metricReaders unset is what lets upstream build its own from OTEL_METRICS_EXPORTER.
      expect(config.metricReaders).toBeUndefined();
    });

    // Supplying any reader stops upstream reading OTEL_METRICS_EXPORTER, so entries beyond the AWS
    // one have to be rebuilt here or they would be silently dropped.
    it('keeps the EMF reader alongside the AWS metrics reader', () => {
      process.env.OTEL_METRICS_EXPORTER = 'awsemf,otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-aws-log-group=test-group,x-aws-log-stream=test-stream';

      const config = new AwsOpentelemetryConfigurator([]).configure();

      expect(config.metricReaders).toHaveLength(2);
    });

    it('keeps a console reader alongside the AWS metrics reader', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp,console';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';

      const config = new AwsOpentelemetryConfigurator([]).configure();

      expect(config.metricReaders).toHaveLength(2);
    });

    // PrometheusExporter is itself a MetricReader, so it must survive the takeover or the user's
    // scrape endpoint would never start.
    it('keeps a prometheus reader alongside the AWS metrics reader', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp,prometheus';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';

      const config = new AwsOpentelemetryConfigurator([]).configure();

      expect(config.metricReaders).toHaveLength(2);
      expect((config.metricReaders as any[]).some(reader => reader instanceof PrometheusExporter)).toBe(true);

      // PrometheusExporter starts an HTTP server; close it so the test does not leak a listener.
      const prometheusReader = (config.metricReaders as any[]).find(reader => reader instanceof PrometheusExporter);
      return prometheusReader.shutdown();
    });

    // Rather than dropping an entry it cannot reproduce, the AWS path declines entirely and lets
    // upstream build every reader. Unsigned metrics are visible; a missing reader is not.
    it('declines the takeover when an entry cannot be reproduced', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp,some-future-exporter';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';

      const config = new AwsOpentelemetryConfigurator([]).configure();

      expect(config.metricReaders).toBeUndefined();
    });

    // awsemf is stripped from OTEL_METRICS_EXPORTER before the metrics path runs, and an empty
    // variable means otlp. Reading it after the strip turned "EMF only" into "sign metrics to
    // CloudWatch" and published billable custom metrics nobody asked for.
    it('does not create an AWS metrics reader when only awsemf was requested', () => {
      process.env.OTEL_METRICS_EXPORTER = 'awsemf';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-aws-log-group=test-group,x-aws-log-stream=test-stream';

      const config = new AwsOpentelemetryConfigurator([]).configure();

      // The EMF reader only. No signed OTLP metrics reader.
      expect(config.metricReaders).toHaveLength(1);
    });

    // PeriodicExportingMetricReader throws on a non-positive interval or timeout, and the
    // configurator is constructed at preload before the SDK's own try/catch, so an unvalidated value
    // would stop the application from starting.
    it('falls back to defaults for non-positive interval and timeout instead of throwing', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';

      for (const [interval, timeout] of [
        ['0', '30000'],
        ['60000', '0'],
        ['-1', '30000'],
        ['60000', '-1'],
      ]) {
        process.env.OTEL_METRIC_EXPORT_INTERVAL = interval;
        process.env.OTEL_METRIC_EXPORT_TIMEOUT = timeout;

        const reader = (new AwsOpentelemetryConfigurator([]).configure().metricReaders as any[])[0];

        expect(reader._exportInterval).toBeGreaterThan(0);
        expect(reader._exportTimeout).toBeGreaterThan(0);
      }

      delete process.env.OTEL_METRIC_EXPORT_INTERVAL;
      delete process.env.OTEL_METRIC_EXPORT_TIMEOUT;
    });

    // PrometheusExporter binds its port in the constructor, so building one and then declining would
    // leave the port held by a reader with no metric producer attached.
    it('does not construct any reader on the decline path', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp,prometheus,some-future-exporter';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';

      const config = new AwsOpentelemetryConfigurator([]).configure();

      expect(config.metricReaders).toBeUndefined();

      // Nothing should be listening on the Prometheus port.
      return new Promise<void>((resolve, reject) => {
        const socket = require('net').connect(9464, '127.0.0.1');
        socket.on('connect', () => {
          socket.destroy();
          reject(new Error('an orphaned PrometheusExporter is holding port 9464'));
        });
        socket.on('error', () => resolve());
      });
    });

    // EMF has no upstream equivalent, so readers must be supplied and an unsupported entry cannot be
    // handed back to upstream. The EMF reader must still be built.
    it('keeps the EMF reader when an entry cannot be reproduced', () => {
      process.env.OTEL_METRICS_EXPORTER = 'awsemf,otlp,some-future-exporter';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-aws-log-group=test-group,x-aws-log-stream=test-stream';

      const config = new AwsOpentelemetryConfigurator([]).configure();

      // EMF plus the signed AWS reader; the unsupported entry is reported, not silently dropped.
      expect(config.metricReaders).toHaveLength(2);
    });

    // The EMF reader has always used the default interval. Making it env-aware would silently change
    // existing export cadence and PutLogEvents volume.
    it('leaves the EMF reader on the default interval', () => {
      process.env.OTEL_METRICS_EXPORTER = 'awsemf';
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-aws-log-group=test-group,x-aws-log-stream=test-stream';
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '5000';

      const reader = (new AwsOpentelemetryConfigurator([]).configure().metricReaders as any[])[0];

      expect(reader._exportInterval).toEqual(60000);

      delete process.env.OTEL_METRIC_EXPORT_INTERVAL;
    });

    it('honors OTEL_METRIC_EXPORT_INTERVAL and OTEL_METRIC_EXPORT_TIMEOUT', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '10000';
      process.env.OTEL_METRIC_EXPORT_TIMEOUT = '5000';

      const reader = (new AwsOpentelemetryConfigurator([]).configure().metricReaders as any[])[0];

      expect(reader._exportInterval).toEqual(10000);
      expect(reader._exportTimeout).toEqual(5000);

      delete process.env.OTEL_METRIC_EXPORT_INTERVAL;
      delete process.env.OTEL_METRIC_EXPORT_TIMEOUT;
    });

    it('clamps the export timeout to the interval', () => {
      process.env.OTEL_METRICS_EXPORTER = 'otlp';
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com/v1/metrics';
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '5000';
      process.env.OTEL_METRIC_EXPORT_TIMEOUT = '20000';

      const reader = (new AwsOpentelemetryConfigurator([]).configure().metricReaders as any[])[0];

      expect(reader._exportInterval).toEqual(5000);
      expect(reader._exportTimeout).toEqual(5000);

      delete process.env.OTEL_METRIC_EXPORT_INTERVAL;
      delete process.env.OTEL_METRIC_EXPORT_TIMEOUT;
    });
  });
});
