// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AWSCloudWatchEMFExporter } from '../src/exporter/aws/metrics/aws-cloudwatch-emf-exporter';
import { Span, TraceFlags, Tracer } from '@opentelemetry/api';
import { OTLPMetricExporter as OTLPGrpcOTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as OTLPHttpOTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter as OTLPGrpcLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPLogExporter as OTLPHttpLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  BatchSpanProcessor,
  ReadableSpan,
  SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import {
  AlwaysOnSampler,
  NodeTracerProvider,
  ParentBasedSampler,
  Sampler,
  SpanExporter,
} from '@opentelemetry/sdk-trace-node';
import * as assert from 'assert';
import expect from 'expect';
import * as sinon from 'sinon';
import { AlwaysRecordSampler } from '../src/always-record-sampler';
import { AttributePropagatingSpanProcessor } from '../src/attribute-propagating-span-processor';
import { AwsBatchUnsampledSpanProcessor } from '../src/aws-batch-unsampled-span-processor';
import { AwsMetricAttributesSpanExporter } from '../src/aws-metric-attributes-span-exporter';
import {
  ApplicationSignalsExporterProvider,
  AwsLoggerProcessorProvider,
  AwsOpentelemetryConfigurator,
  AwsSpanProcessorProvider,
  checkEmfExporterEnabled,
  createEmfExporter,
  customBuildSamplerFromEnv,
  isAwsOtlpEndpoint,
  validateAndFetchLogsHeader,
} from '../src/aws-opentelemetry-configurator';
import { AwsSpanMetricsProcessor } from '../src/aws-span-metrics-processor';
import { OTLPUdpSpanExporter } from '../src/otlp-udp-exporter';
import { setAwsDefaultEnvironmentVariables } from '../src/register';
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

// Tests AwsOpenTelemetryConfigurator after running Environment Variable setup in register.ts
describe('AwsOpenTelemetryConfiguratorTest', () => {
  let awsOtelConfigurator: AwsOpentelemetryConfigurator;

  // setUpClass
  before(() => {
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
  });

  // The probability of this passing once without correct IDs is low, 20 times is inconceivable.
  it('ProvideGenerateXrayIdsTest', () => {
    const tracerProvider: NodeTracerProvider = new NodeTracerProvider(awsOtelConfigurator.configure());
    tracerProvider.addSpanProcessor(
      AttributePropagatingSpanProcessor.create((span: ReadableSpan) => '', 'spanNameKey', ['testKey1', 'testKey2'])
    );
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

  // Sanity check that the trace ID ratio sampler works fine with the x-ray generator.
  it('TraceIdRatioSamplerTest', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    const tracerProvider: NodeTracerProvider = new NodeTracerProvider(awsOtelConfigurator.configure());
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;

    tracerProvider.addSpanProcessor(
      AttributePropagatingSpanProcessor.create((span: ReadableSpan) => '', 'spanNameKey', ['testKey1', 'testKey2'])
    );
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
    const defaultSampler: Sampler = customBuildSamplerFromEnv(Resource.empty());

    expect(defaultSampler).not.toBeUndefined();
    expect(defaultSampler.toString()).toEqual(new ParentBasedSampler({ root: new AlwaysOnSampler() }).toString());
  });

  it('ImportXRaySamplerWhenEnvVarIsSetTest', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    process.env.OTEL_TRACES_SAMPLER = 'xray';
    const sampler = customBuildSamplerFromEnv(Resource.empty());

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
    const sampler = customBuildSamplerFromEnv(Resource.empty());

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

    const sampler = customBuildSamplerFromEnv(Resource.empty());

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

    let sampler = customBuildSamplerFromEnv(Resource.empty());

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

    sampler = customBuildSamplerFromEnv(Resource.empty());

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
      Resource.empty()
    );
    expect(mockExporter).toEqual(customizedExporter);

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    customizedExporter = AwsSpanProcessorProvider.customizeSpanExporter(mockExporter, Resource.empty());
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
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
    expect(spanProcessors.length).toEqual(0);

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
    expect(spanProcessors.length).toEqual(2);
    const firstProcessor: SpanProcessor = spanProcessors[0];
    expect(firstProcessor).toBeInstanceOf(AttributePropagatingSpanProcessor);
    const secondProcessor: SpanProcessor = spanProcessors[1];
    expect(secondProcessor).toBeInstanceOf(AwsSpanMetricsProcessor);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;

    try {
      process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
      process.env.OTEL_METRIC_EXPORT_INTERVAL = undefined;
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '123abc';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '!@#$%^&*()';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '40000';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
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
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
    expect(spanProcessors.length).toEqual(3);

    // Verify processors are added in the expected order
    expect(spanProcessors[0]).toBeInstanceOf(BaggageSpanProcessor);
    expect(spanProcessors[1]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect(spanProcessors[2]).toBeInstanceOf(AwsSpanMetricsProcessor);

    // shut down exporters for test cleanup
    spanProcessors.forEach(spanProcessor => {
      spanProcessor.shutdown();
    });
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
  });

  it('CustomizeSpanProcessorsWithAgentObservabilityTest', () => {
    const spanProcessorsToTest: SpanProcessor[] = [];

    // Test that BaggageSpanProcessor is not added when agent observability is disabled
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, Resource.empty());
    expect(spanProcessorsToTest).toEqual([]);

    // Test that BaggageSpanProcessor is added when agent observability is enabled
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, Resource.empty());
    expect(spanProcessorsToTest.length).toEqual(1);

    // Verify the added processor is BaggageSpanProcessor
    const addedProcessor = spanProcessorsToTest[0];
    expect(addedProcessor).toBeInstanceOf(BaggageSpanProcessor);

    // Clean up
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
  });

  it('BaggageSpanProcessorSessionIdFilteringTest', () => {
    // Set up agent observability
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

    // Create a SpanProcessor list for this test
    const spanProcessorsToTest: SpanProcessor[] = [];

    // Add our span processors
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, Resource.empty());

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
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'http/protobuf';
    exporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    expect(exporter).toBeInstanceOf(OTLPHttpOTLPMetricExporter);
    expect('http://my_custom_endpoint').toEqual((exporter as any)._delegate._transport._transport._parameters.url);

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
      Resource.empty()
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
      Resource.empty()
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
    expect((config.spanProcessors as any)[0]).toBeInstanceOf(BatchSpanProcessor);
    expect((config.spanProcessors as any)[0]._exporter).toBeInstanceOf(OTLPUdpSpanExporter);
    expect((config.spanProcessors as any)[0]._exporter._endpoint).toBe('www.test.com:2222');
    expect(config.spanProcessors?.length).toEqual(1);

    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.AWS_XRAY_DAEMON_ADDRESS;
  });

  it('Test CustomizeSpanProcessors for Lambda', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'True';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'TestFunction';
    const spanProcessors: SpanProcessor[] = [];
    AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessors, Resource.empty());
    expect(spanProcessors.length).toEqual(2);
    const firstProcessor: SpanProcessor = spanProcessors[0];
    expect(firstProcessor).toBeInstanceOf(AttributePropagatingSpanProcessor);
    const secondProcessor: SpanProcessor = spanProcessors[1];
    expect(secondProcessor).toBeInstanceOf(AwsBatchUnsampledSpanProcessor);
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  function validateConfiguratorEnviron() {
    // Set by register.ts
    expect('http/protobuf').toEqual(process.env.OTEL_EXPORTER_OTLP_PROTOCOL);
    expect('xray,tracecontext').toEqual(process.env.OTEL_PROPAGATORS);

    // Not set
    expect(undefined).toEqual(process.env.OTEL_TRACES_SAMPLER);
    expect(undefined).toEqual(process.env.OTEL_TRACES_SAMPLER_ARG);
    expect(undefined).toEqual(process.env.OTEL_TRACES_EXPORTER);
    expect(undefined).toEqual(process.env.OTEL_METRICS_EXPORTER);
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
    expect((config.spanProcessors as any)[0]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect((config.spanProcessors as any)[1]).toBeInstanceOf(AwsSpanMetricsProcessor);
    expect(config.spanProcessors?.length).toEqual(2);

    // Scenario where otlp trace exporter is specified, adds one more exporter compared to default case
    process.env.OTEL_TRACES_EXPORTER = 'otlp';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.spanProcessors as any)[0]._exporter.delegate).toBeInstanceOf(OTLPProtoTraceExporter);
    expect((config.spanProcessors as any)[1]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect((config.spanProcessors as any)[2]).toBeInstanceOf(AwsSpanMetricsProcessor);
    expect(config.spanProcessors?.length).toEqual(3);

    // Specify invalid exporter, same result as default scenario where no trace exporter is specified
    process.env.OTEL_TRACES_EXPORTER = 'invalid_exporter_name';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect((config.spanProcessors as any)[0]).toBeInstanceOf(AttributePropagatingSpanProcessor);
    expect((config.spanProcessors as any)[1]).toBeInstanceOf(AwsSpanMetricsProcessor);
    expect(config.spanProcessors?.length).toEqual(2);

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

    // Cleanup
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
  });

  it('ResourceDetectorInputValidationTest', () => {
    let config;
    process.env.OTEL_SERVICE_NAME = 'test_service_name';

    // Default 2 attributes detected in test environment
    process.env.OTEL_NODE_RESOURCE_DETECTORS = 'container';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(Object.keys((config.resource as any).attributes).length).toEqual(2);
    expect((config.resource as any).attributes['service.name']).toEqual('test_service_name');
    expect((config.resource as any).attributes['telemetry.auto.version'].endsWith('-aws')).toBeTruthy();

    // Still default 2 attributes detected given invalid resource detectors
    process.env.OTEL_NODE_RESOURCE_DETECTORS = 'invalid_detector_1,invalid_detector_2';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(Object.keys((config.resource as any).attributes).length).toEqual(2);
    expect((config.resource as any).attributes['service.name']).toEqual('test_service_name');
    expect((config.resource as any).attributes['telemetry.auto.version'].endsWith('-aws')).toBeTruthy();

    // Still default 2 attributes detected given mix of valid and invalid resource detectors
    process.env.OTEL_NODE_RESOURCE_DETECTORS = 'container,invalid_detector_1,invalid_detector_2';
    config = new AwsOpentelemetryConfigurator([]).configure();
    expect(Object.keys((config.resource as any).attributes).length).toEqual(2);
    expect((config.resource as any).attributes['service.name']).toEqual('test_service_name');
    expect((config.resource as any).attributes['telemetry.auto.version'].endsWith('-aws')).toBeTruthy();

    // Cleanup
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
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
      ];

      const tracesBadEndpoints = [
        'http://localhost:4318/v1/traces',
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

      delete process.env.OTEL_LOGS_EXPORTER;
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
      ];

      const logsBadEndpoints = [
        'http://localhost:4318/v1/logs',
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
    AwsOpentelemetryConfigurator.exportUnsampledSpanForAgentObservability(spanProcessorsToTest, Resource.empty());
    expect(spanProcessorsToTest).toEqual([]);

    // Test with agent observability enabled
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://xray.us-east-1.amazonaws.com/v1/traces';

    AwsOpentelemetryConfigurator.exportUnsampledSpanForAgentObservability(spanProcessorsToTest, Resource.empty());
    expect(spanProcessorsToTest.length).toEqual(1);

    const processor = spanProcessorsToTest[0];
    expect(processor).toBeInstanceOf(AwsBatchUnsampledSpanProcessor);

    // Cleanup
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  });

  it('ExportUnsampledSpanForAgentObservabilityUsesOtlpAwsSpanExporterTest', () => {
    const spanProcessorsToTest: SpanProcessor[] = [];

    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://xray.us-east-1.amazonaws.com/v1/traces';

    AwsOpentelemetryConfigurator.exportUnsampledSpanForAgentObservability(spanProcessorsToTest, Resource.empty());

    // Verify AwsBatchUnsampledSpanProcessor was created with the AWS exporter
    expect(spanProcessorsToTest[0]).toBeInstanceOf(AwsBatchUnsampledSpanProcessor);
    const otlpAwsSpanExporter = (spanProcessorsToTest[0] as AwsBatchUnsampledSpanProcessor)['_exporter'];

    // Verify OTLPAwsSpanExporter was created with correct parameters
    expect(otlpAwsSpanExporter).toBeInstanceOf(OTLPAwsSpanExporter);
    expect(otlpAwsSpanExporter['endpoint']).toEqual('https://xray.us-east-1.amazonaws.com/v1/traces');
    expect(otlpAwsSpanExporter['loggerProvider']).toBeDefined();

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
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, Resource.empty());
      expect(exportUnsampledSpanSpy.called).toBeFalsy();

      // Test that function is called when agent observability is enabled
      exportUnsampledSpanSpy.resetHistory();
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
      AwsOpentelemetryConfigurator.customizeSpanProcessors(spanProcessorsToTest, Resource.empty());
      expect(exportUnsampledSpanSpy.calledOnce).toBeTruthy();
      expect(exportUnsampledSpanSpy.calledWith(spanProcessorsToTest, Resource.empty())).toBeTruthy();
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

  it('testCreateEmfExporter', async () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS =
      'x-aws-log-group=/test/log/group/name,x-aws-log-stream=test_log_stream_name,x-aws-metric-namespace=TEST_NAMESPACE';
    const exporter = createEmfExporter();
    expect(exporter).toBeInstanceOf(AWSCloudWatchEMFExporter);
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
  });

  it('testIsAwsOtlpEndpoint', () => {
    expect(isAwsOtlpEndpoint('https://xray.us-east-1.amazonaws.com/v1/traces', 'xray')).toBeTruthy();
    expect(isAwsOtlpEndpoint('https://lambda.us-east-1.amazonaws.com/v1/traces', 'xray')).toBeFalsy();
    expect(isAwsOtlpEndpoint('https://xray.us-east-1.amazonaws.com/v1/logs', 'xray')).toBeFalsy();
    expect(isAwsOtlpEndpoint('https://logs.us-east-1.amazonaws.com/v1/logs', 'logs')).toBeTruthy();
    expect(isAwsOtlpEndpoint('https://lambda.us-east-1.amazonaws.com/v1/logs', 'logs')).toBeFalsy();
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
      logGroup: '',
      logStream: '',
      namespace: '',
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

    let resource = new Resource({ [ATTR_SERVICE_NAME]: 'test-service' });
    resource = awsOtelConfigurator['customizeResource'](resource);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toEqual('test-service');
    expect(resource.attributes).not.toHaveProperty(AWS_ATTRIBUTE_KEYS.AWS_SERVICE_TYPE);
  });

  it('CustomizeResourceWithAgentObservabilityDefault', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

    let resource = new Resource({ [ATTR_SERVICE_NAME]: 'test-service' });
    resource = awsOtelConfigurator['customizeResource'](resource);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toEqual('test-service');
    expect(resource.attributes[AWS_ATTRIBUTE_KEYS.AWS_SERVICE_TYPE]).toEqual('gen_ai_agent');

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
  });

  it('CustomizeResourceWithoutAgentObservability', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

    let resource = new Resource({
      [ATTR_SERVICE_NAME]: 'test-service',
      [AWS_ATTRIBUTE_KEYS.AWS_SERVICE_TYPE]: 'existing-agent',
    });
    resource = awsOtelConfigurator['customizeResource'](resource);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toEqual('test-service');
    expect(resource.attributes[AWS_ATTRIBUTE_KEYS.AWS_SERVICE_TYPE]).toEqual('existing-agent');

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
  });
});
