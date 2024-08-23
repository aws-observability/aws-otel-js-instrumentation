// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import { TextMapPropagator, diag } from '@opentelemetry/api';
import { getPropagator } from '@opentelemetry/auto-configuration-propagators';
import { getResourceDetectors as getResourceDetectorsFromEnv } from '@opentelemetry/auto-instrumentations-node';
import { ENVIRONMENT, TracesSamplerValues, getEnv, getEnvWithoutDefaults } from '@opentelemetry/core';
import { OTLPMetricExporter as OTLPGrpcOTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter as OTLPHttpOTLPMetricExporter,
} from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { awsEc2Detector, awsEcsDetector, awsEksDetector } from '@opentelemetry/resource-detector-aws';
import {
  Detector,
  DetectorSync,
  Resource,
  ResourceDetectionConfig,
  detectResourcesSync,
  envDetectorSync,
  hostDetector,
  processDetector,
} from '@opentelemetry/resources';
import {
  Aggregation,
  AggregationSelector,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  IdGenerator,
  ParentBasedSampler,
  Sampler,
  SimpleSpanProcessor,
  SpanExporter,
  SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { SEMRESATTRS_TELEMETRY_AUTO_VERSION } from '@opentelemetry/semantic-conventions';
import { AlwaysRecordSampler } from './always-record-sampler';
import { AttributePropagatingSpanProcessorBuilder } from './attribute-propagating-span-processor-builder';
import { AwsBatchUnsampledSpanProcessor } from './aws-batch-unsampled-span-processor';
import { AwsMetricAttributesSpanExporterBuilder } from './aws-metric-attributes-span-exporter-builder';
import { AwsSpanMetricsProcessorBuilder } from './aws-span-metrics-processor-builder';
import { OTLPUdpSpanExporter } from './otlp-udp-exporter';
import { AwsXRayRemoteSampler } from './sampler/aws-xray-remote-sampler';
// This file is generated via `npm run compile`
import { LIB_VERSION } from './version';

const APPLICATION_SIGNALS_ENABLED_CONFIG = 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED';
const APPLICATION_SIGNALS_EXPORTER_ENDPOINT_CONFIG = 'OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT';
const METRIC_EXPORT_INTERVAL_CONFIG = 'OTEL_METRIC_EXPORT_INTERVAL';
const DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS = 60000;
const AWS_LAMBDA_FUNCTION_NAME_CONFIG = 'AWS_LAMBDA_FUNCTION_NAME';
const AWS_XRAY_DAEMON_ADDRESS_CONFIG = 'AWS_XRAY_DAEMON_ADDRESS';
const FORMAT_OTEL_SAMPLED_TRACES_BINARY_PREFIX = 'T1S';
const FORMAT_OTEL_UNSAMPLED_TRACES_BINARY_PREFIX = 'T1U';
/**
 * Aws Application Signals Config Provider creates a configuration object that can be provided to
 * the OTel NodeJS SDK for Auto Instrumentation with Application Signals Functionality.
 *
 * The config includes:
 *  - Use AlwaysRecordSampler (wraps around a specified Sampler) to record all spans.
 *  - Add SpanMetricsProcessor to create metrics.
 *  - Add AttributePropagatingSpanProcessor to propagate span attributes from parent to child spans.
 *  - Add AwsMetricAttributesSpanExporter to add more attributes to all spans.
 *
 *  You can control when these customizations are applied using the environment variable
 *  OTEL_AWS_APPLICATION_SIGNALS_ENABLED. This flag is disabled by default.
 */
export class AwsOpentelemetryConfigurator {
  private resource: Resource;
  private instrumentations: Instrumentation[];
  private idGenerator: IdGenerator;
  private sampler: Sampler;
  private spanProcessors: SpanProcessor[];
  private propagator: TextMapPropagator;

  /**
   * The constructor will setup the AwsOpentelemetryConfigurator object to be able to provide a
   * configuration for ADOT JavaScript Auto-Instrumentation.
   *
   * The `instrumentations` are the desired Node auto-instrumentations to be used when using ADOT JavaScript.
   * The auto-Instrumentions are usually populated from OTel's `getNodeAutoInstrumentations()` method from the
   * `@opentelemetry/auto-instrumentations-node` NPM package, and may have instrumentation patching applied.
   *
   * @constructor
   * @param {Instrumentation[]} instrumentations - Auto-Instrumentations to be added to the ADOT Config
   */
  public constructor(instrumentations: Instrumentation[]) {
    /*
     * Set and Detect Resources via Resource Detectors
     *
     * The configurator must create and detect resources in order to populate any detected
     * resources into the Resource that is provided to the processors, exporters, and samplers
     * that are instantiated in the configurator. Otherwise, if only OTel handles resource
     * detection in the SDK, the AWS processors/exporters/samplers will lack such detected
     * resources in their respective resources.
     */
    let autoResource: Resource = new Resource({});
    autoResource = this.customizeVersions(autoResource);

    // The following if/else block is based on upstream's logic
    // https://github.com/open-telemetry/opentelemetry-js/blob/95edbd9992434f31f50532fedb3c7e8db5164479/experimental/packages/opentelemetry-sdk-node/src/sdk.ts#L125-L129
    // In all cases, we want to include the Env Detector (Sync) and the AWS Resource Detectors
    let defaultDetectors: (Detector | DetectorSync)[] = [];
    if (process.env.OTEL_NODE_RESOURCE_DETECTORS != null) {
      defaultDetectors = getResourceDetectorsFromEnv();
      // Add Env/AWS Resource Detectors if not present
      const resourceDetectorsFromEnv: string[] = process.env.OTEL_NODE_RESOURCE_DETECTORS.split(',');
      if (!resourceDetectorsFromEnv.includes('env')) {
        defaultDetectors.push(envDetectorSync);
      }
      if (!resourceDetectorsFromEnv.includes('aws')) {
        defaultDetectors.push(awsEc2Detector, awsEcsDetector, awsEksDetector);
      }
    } else {
      /*
       * envDetectorSync is used as opposed to envDetector (async), so it is guaranteed that the
       * resource is populated with configured OTEL_RESOURCE_ATTRIBUTES or OTEL_SERVICE_NAME env
       * var values by the time that this class provides a configuration to the OTel SDK.
       *
       * envDetectorSync needs to be last so it can override any conflicting resource attributes.
       */
      defaultDetectors = [
        processDetector,
        hostDetector,
        awsEc2Detector,
        awsEcsDetector,
        awsEksDetector,
        envDetectorSync,
      ];
    }

    const internalConfig: ResourceDetectionConfig = {
      detectors: defaultDetectors,
    };

    autoResource = autoResource.merge(detectResourcesSync(internalConfig));
    this.resource = autoResource;

    this.instrumentations = instrumentations;
    this.propagator = getPropagator();

    // TODO: Consider removing AWSXRayIdGenerator as it is not needed
    // Similarly to Java, always use AWS X-Ray Id Generator
    // https://github.com/aws-observability/aws-otel-java-instrumentation/blob/a011b8cc29ee32b7f668c04ccfdf64cd30de467c/awsagentprovider/src/main/java/software/amazon/opentelemetry/javaagent/providers/AwsTracerCustomizerProvider.java#L36
    this.idGenerator = new AWSXRayIdGenerator();

    this.sampler = AwsOpentelemetryConfigurator.customizeSampler(customBuildSamplerFromEnv(this.resource));

    // default SpanProcessors with Span Exporters wrapped inside AwsMetricAttributesSpanExporter
    const awsSpanProcessorProvider: AwsSpanProcessorProvider = new AwsSpanProcessorProvider(this.resource);
    this.spanProcessors = awsSpanProcessorProvider.getSpanProcessors();
    AwsOpentelemetryConfigurator.customizeSpanProcessors(this.spanProcessors, this.resource);
  }

  private customizeVersions(autoResource: Resource): Resource {
    // eslint-disable-next-line @typescript-eslint/typedef
    const DISTRO_VERSION: string = LIB_VERSION;
    autoResource.attributes[SEMRESATTRS_TELEMETRY_AUTO_VERSION] = DISTRO_VERSION + '-aws';
    diag.debug(
      `@aws/aws-distro-opentelemetry-node-autoinstrumentation - version: ${autoResource.attributes[SEMRESATTRS_TELEMETRY_AUTO_VERSION]}`
    );
    return autoResource;
  }

  public configure(): Partial<NodeSDKConfiguration> {
    let config: Partial<NodeSDKConfiguration>;
    if (AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()) {
      // config.autoDetectResources is set to False, as the resources are detected and added to the
      // resource ahead of time. The resource is needed to be populated ahead of time instead of letting
      // the OTel Node SDK do the population work because the constructed resource was required to build
      // the sampler (if using XRay sampler) and the AwsMetricAttributesSpanExporter and AwsSpanMetricsProcessor
      config = {
        instrumentations: this.instrumentations,
        resource: this.resource,
        idGenerator: this.idGenerator,
        sampler: this.sampler,
        // Error message 'Exporter "otlp" requested through environment variable is unavailable.'
        // will appear from BasicTracerProvider that is used in the OTel JS SDK, even though the
        // span processors are specified
        // https://github.com/open-telemetry/opentelemetry-js/issues/3449
        spanProcessors: this.spanProcessors,
        autoDetectResources: false,
        textMapPropagator: this.propagator,
      };
    } else {
      // Default experience config
      config = {
        instrumentations: this.instrumentations,
        resource: this.resource,
        sampler: this.sampler,
        idGenerator: this.idGenerator,
        autoDetectResources: false,
      };
    }

    return config;
  }

  static isApplicationSignalsEnabled(): boolean {
    const isApplicationSignalsEnabled: string | undefined = process.env[APPLICATION_SIGNALS_ENABLED_CONFIG];
    if (isApplicationSignalsEnabled === undefined) {
      return false;
    }

    return isApplicationSignalsEnabled.toLowerCase() === 'true';
  }

  static customizeSpanProcessors(spanProcessors: SpanProcessor[], resource: Resource): void {
    if (!AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()) {
      return;
    }

    diag.info('AWS Application Signals enabled.');

    // Register BatchUnsampledSpanProcessor to export unsampled traces in Lambda
    // when Application Signals enabled
    if (isLambdaEnvironment()) {
      spanProcessors.push(
        new AwsBatchUnsampledSpanProcessor(
          new OTLPUdpSpanExporter(getXrayDaemonEndpoint(), FORMAT_OTEL_UNSAMPLED_TRACES_BINARY_PREFIX)
        )
      );
      diag.info('Enabled batch unsampled span processor for Lambda environment.');
    }

    let exportIntervalMillis = Number(process.env[METRIC_EXPORT_INTERVAL_CONFIG]);
    diag.debug(`AWS Application Signals Metrics export interval: ${exportIntervalMillis}`);

    if (isNaN(exportIntervalMillis) || exportIntervalMillis.valueOf() > DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS) {
      exportIntervalMillis = DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS;

      diag.info(`AWS Application Signals metrics export interval capped to ${exportIntervalMillis}`);
    }

    spanProcessors.push(AttributePropagatingSpanProcessorBuilder.create().build());
    const applicationSignalsMetricExporter: PushMetricExporter =
      ApplicationSignalsExporterProvider.Instance.createExporter();
    const periodicExportingMetricReader: PeriodicExportingMetricReader = new PeriodicExportingMetricReader({
      exporter: applicationSignalsMetricExporter,
      exportIntervalMillis: exportIntervalMillis,
    });
    const meterProvider: MeterProvider = new MeterProvider({
      /** Resource associated with metric telemetry  */
      resource: resource,
      readers: [periodicExportingMetricReader],
    });
    spanProcessors.push(AwsSpanMetricsProcessorBuilder.create(meterProvider, resource).build());
  }

  static customizeSampler(sampler: Sampler): Sampler {
    if (AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()) {
      return AlwaysRecordSampler.create(sampler);
    }
    return sampler;
  }
}

export function customBuildSamplerFromEnv(resource: Resource): Sampler {
  switch (process.env.OTEL_TRACES_SAMPLER) {
    case 'xray': {
      const samplerArgumentEnv: string | undefined = process.env.OTEL_TRACES_SAMPLER_ARG;
      let endpoint: string | undefined = undefined;
      let pollingInterval: number | undefined = undefined;

      if (samplerArgumentEnv !== undefined) {
        const args: string[] = samplerArgumentEnv.split(',');
        for (const arg of args) {
          const equalIndex: number = arg.indexOf('=');
          if (equalIndex === -1) {
            continue;
          }
          const keyValue: string[] = [arg.substring(0, equalIndex), arg.substring(equalIndex + 1)];
          if (keyValue[0] === 'endpoint') {
            endpoint = keyValue[1];
          } else if (keyValue[0] === 'polling_interval') {
            pollingInterval = Number(keyValue[1]);
            if (isNaN(pollingInterval)) {
              pollingInterval = undefined;
              diag.error('polling_interval in OTEL_TRACES_SAMPLER_ARG must be a valid number');
            }
          }
        }
      }

      diag.debug(`XRay Sampler Endpoint: ${endpoint}`);
      diag.debug(`XRay Sampler Polling Interval: ${pollingInterval}`);
      return new AwsXRayRemoteSampler({ resource: resource, endpoint: endpoint, pollingInterval: pollingInterval });
    }
  }

  return buildSamplerFromEnv();
}

export class ApplicationSignalsExporterProvider {
  private static _instance: ApplicationSignalsExporterProvider;
  private constructor() {}
  public static get Instance() {
    return this._instance || (this._instance = new this());
  }

  public createExporter(): PushMetricExporter {
    let protocol: string | undefined = process.env['OTEL_EXPORTER_OTLP_METRICS_PROTOCOL'];
    if (protocol === undefined) {
      protocol = process.env['OTEL_EXPORTER_OTLP_PROTOCOL'];
    }
    if (protocol === undefined) {
      protocol = 'grpc';
    }

    diag.debug(`AWS Application Signals export protocol: ${protocol}`);

    const temporalityPreference: AggregationTemporalityPreference = AggregationTemporalityPreference.DELTA;
    const aggregationPreference: AggregationSelector = this.aggregationSelector;

    if (protocol === 'http/protobuf') {
      let applicationSignalsEndpoint: string | undefined = process.env[APPLICATION_SIGNALS_EXPORTER_ENDPOINT_CONFIG];
      if (applicationSignalsEndpoint === undefined) {
        applicationSignalsEndpoint = 'http://localhost:4316/v1/metrics';
      }
      diag.debug(`AWS Application Signals export endpoint: ${applicationSignalsEndpoint}`);

      return new OTLPHttpOTLPMetricExporter({
        url: applicationSignalsEndpoint,
        temporalityPreference: temporalityPreference,
        aggregationPreference: aggregationPreference,
      });
    }
    if (protocol === 'grpc') {
      let applicationSignalsEndpoint: string | undefined = process.env[APPLICATION_SIGNALS_EXPORTER_ENDPOINT_CONFIG];
      if (applicationSignalsEndpoint === undefined) {
        applicationSignalsEndpoint = 'http://localhost:4315';
      }
      diag.debug(`AWS Application Signals export endpoint: ${applicationSignalsEndpoint}`);

      return new OTLPGrpcOTLPMetricExporter({
        url: applicationSignalsEndpoint,
        temporalityPreference: temporalityPreference,
        aggregationPreference: aggregationPreference,
      });
    }

    throw new Error(`Unsupported AWS Application Signals export protocol: ${protocol}`);
  }

  private aggregationSelector: AggregationSelector = (instrumentType: InstrumentType) => {
    switch (instrumentType) {
      case InstrumentType.HISTOGRAM: {
        return Aggregation.ExponentialHistogram();
      }
    }
    return Aggregation.Default();
  };
}

// The OpenTelemetry Authors code
//
// ADOT JS needs the logic to (1) get the SpanExporters from Env and then (2) wrap the SpanExporters with AwsMetricAttributesSpanExporter
// However, the logic to perform (1) is only in the `TracerProviderWithEnvExporters` class, which is not exported publicly.
// `TracerProviderWithEnvExporters` is also responsible for (3) wrapping the SpanExporters inside the Simple/Batch SpanProcessors
// which must happen after (2). Thus in order to perform (1), (2), and (3), we need to add these non-exported methods here.
//
// https://github.com/open-telemetry/opentelemetry-js/blob/01cea7caeb130142cc017f77ea74834a35d0e8d6/experimental/packages/opentelemetry-sdk-node/src/TracerProviderWithEnvExporter.ts
//
// This class is a modified version of TracerProviderWithEnvExporters (extends NodeTracerProvider), without
// any of the TracerProvider functionalities. The AwsSpanProcessorProvider retains the functionality to
// only create the default span processors with exporters specified in `OTEL_TRACES_EXPORTER`. These span
// exporters are wrapped with AwsMetricAttributesSpanExporter when configuring the configureSpanProcessors
//
// Unlike `TracerProviderWithEnvExporters`, `AwsSpanProcessorProvider` does not extend `NodeTracerProvider`.
// The following class member variables are unmodified:
//   - _configuredExporters
//   - _spanProcessors
// The following class member variables are modified:
//   - _hasSpanProcessors (removed)
//   - resource (new)
// The following methods are unmodified:
//   - configureOtlp(), getOtlpProtocol(), configureJaeger(), createExportersFromList(), _getSpanExporter(), filterBlanksAndNulls()
// The following methods are modified:
//   - constructor() (modified)
//     - removed usage of `this.addSpanProcessor(...)`, which calls `super.addSpanProcessor(...)`
//       to register it to the BasicTracerProvider, which should be done later by the OTel JS SDK
//   - configureSpanProcessors(exporters) (modified)
//     - wrap exporters with customizeSpanExporter()
//   - customizeSpanExporter() (new)
//   - getSpanProcessors() (new)
//   - override addSpanProcessor() (removed)
//   - override register() (removed)
//
// TODO: `TracerProviderWithEnvExporters` is not exported, thus its useful static methods that
// provides some default SpanExporter configurations are unavailable. Ideally, we could contribute
// to upstream to export `TracerProviderWithEnvExporters`
export class AwsSpanProcessorProvider {
  private _configuredExporters: SpanExporter[] = [];
  private _spanProcessors: SpanProcessor[] = [];
  private resource: Resource;

  static configureOtlp(): SpanExporter {
    // eslint-disable-next-line @typescript-eslint/typedef
    let protocol = this.getOtlpProtocol();

    if (AwsOpentelemetryConfigurator.isApplicationSignalsEnabled() && isLambdaEnvironment()) {
      protocol = 'udp';
    }
    switch (protocol) {
      case 'grpc':
        return new OTLPGrpcTraceExporter();
      case 'http/json':
        return new OTLPHttpTraceExporter();
      case 'http/protobuf':
        return new OTLPProtoTraceExporter();
      case 'udp':
        diag.debug('Detected AWS Lambda environment and enabling UDPSpanExporter');
        return new OTLPUdpSpanExporter(getXrayDaemonEndpoint(), FORMAT_OTEL_SAMPLED_TRACES_BINARY_PREFIX);
      default:
        diag.warn(`Unsupported OTLP traces protocol: ${protocol}. Using http/protobuf.`);
        return new OTLPProtoTraceExporter();
    }
  }

  static getOtlpProtocol(): string {
    // eslint-disable-next-line @typescript-eslint/typedef
    const parsedEnvValues = getEnvWithoutDefaults();

    return (
      parsedEnvValues.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ??
      parsedEnvValues.OTEL_EXPORTER_OTLP_PROTOCOL ??
      getEnv().OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ??
      getEnv().OTEL_EXPORTER_OTLP_PROTOCOL
    );
  }

  private static configureJaeger() {
    // The JaegerExporter does not support being required in bundled
    // environments. By delaying the require statement to here, we only crash when
    // the exporter is actually used in such an environment.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
      return new JaegerExporter();
    } catch (e) {
      throw new Error(
        `Could not instantiate JaegerExporter. This could be due to the JaegerExporter's lack of support for bundling. If possible, use @opentelemetry/exporter-trace-otlp-proto instead. Original Error: ${e}`
      );
    }
  }

  protected static _registeredExporters = new Map<string, () => SpanExporter>([
    ['otlp', () => this.configureOtlp()],
    ['zipkin', () => new ZipkinExporter()],
    ['jaeger', () => this.configureJaeger()],
    ['console', () => new ConsoleSpanExporter()],
  ]);

  public constructor(resource: Resource) {
    this.resource = resource;

    // eslint-disable-next-line @typescript-eslint/typedef
    let traceExportersList = this.filterBlanksAndNulls(Array.from(new Set(getEnv().OTEL_TRACES_EXPORTER.split(','))));

    if (traceExportersList[0] === 'none') {
      diag.warn('OTEL_TRACES_EXPORTER contains "none". SDK will not be initialized.');
    } else if (traceExportersList.length === 0) {
      diag.warn('OTEL_TRACES_EXPORTER is empty. Using default otlp exporter.');

      traceExportersList = ['otlp'];
      this.createExportersFromList(traceExportersList);

      this._spanProcessors = this.configureSpanProcessors(this._configuredExporters);
    } else {
      if (traceExportersList.length > 1 && traceExportersList.includes('none')) {
        diag.warn('OTEL_TRACES_EXPORTER contains "none" along with other exporters. Using default otlp exporter.');
        traceExportersList = ['otlp'];
      }

      this.createExportersFromList(traceExportersList);

      if (this._configuredExporters.length > 0) {
        this._spanProcessors = this.configureSpanProcessors(this._configuredExporters);
      } else {
        diag.warn('Unable to set up trace exporter(s) due to invalid exporter and/or protocol values.');
      }
    }
  }

  private createExportersFromList(exporterList: string[]) {
    exporterList.forEach(exporterName => {
      // eslint-disable-next-line @typescript-eslint/typedef
      const exporter = this._getSpanExporter(exporterName);
      if (exporter) {
        this._configuredExporters.push(exporter);
      } else {
        diag.warn(`Unrecognized OTEL_TRACES_EXPORTER value: ${exporterName}.`);
      }
    });
  }

  protected _getSpanExporter(name: string): SpanExporter | undefined {
    return AwsSpanProcessorProvider._registeredExporters.get(name)?.();
  }

  private configureSpanProcessors(exporters: SpanExporter[]): (BatchSpanProcessor | SimpleSpanProcessor)[] {
    return exporters.map(exporter => {
      const configuredExporter: SpanExporter = AwsSpanProcessorProvider.customizeSpanExporter(exporter, this.resource);
      if (exporter instanceof ConsoleSpanExporter) {
        return new SimpleSpanProcessor(configuredExporter);
      } else {
        return new BatchSpanProcessor(configuredExporter);
      }
    });
  }

  private filterBlanksAndNulls(list: string[]): string[] {
    return list.map(item => item.trim()).filter(s => s !== 'null' && s !== '');
  }

  public static customizeSpanExporter(spanExporter: SpanExporter, resource: Resource): SpanExporter {
    if (AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()) {
      return AwsMetricAttributesSpanExporterBuilder.create(spanExporter, resource).build();
    }
    return spanExporter;
  }

  public getSpanProcessors(): SpanProcessor[] {
    return this._spanProcessors;
  }
}
// END The OpenTelemetry Authors code

// The OpenTelemetry Authors code
//
// We need the logic to build the Sampler from user-defined Environment variables in order
// to wrap the Sampler with an AlwaysRecord sampler. However, this logic is not exported
// in an `index.ts` file, so the portion of code that does this is added here.
//
// TODO: Ideally, upstream's `buildSamplerFromEnv()` method should be exported
// https://github.com/open-telemetry/opentelemetry-js/blob/f047db9da20a7d4394169f812b2d255d934883f1/packages/opentelemetry-sdk-trace-base/src/config.ts#L62
//
// An alternative method is to instantiate a new OTel JS Tracer with an empty config, which
// would also have the (private+readonly) sampler from the `buildSamplerFromEnv()` method.
// https://github.com/open-telemetry/opentelemetry-js/blob/01cea7caeb130142cc017f77ea74834a35d0e8d6/packages/opentelemetry-sdk-trace-base/src/Tracer.ts#L36-L53
const FALLBACK_OTEL_TRACES_SAMPLER: string = TracesSamplerValues.AlwaysOn;
const DEFAULT_RATIO = 1;

/**
 * Based on environment, builds a sampler, complies with specification.
 * @param environment optional, by default uses getEnv(), but allows passing a value to reuse parsed environment
 */
export function buildSamplerFromEnv(environment: Required<ENVIRONMENT> = getEnv()): Sampler {
  switch (environment.OTEL_TRACES_SAMPLER) {
    case TracesSamplerValues.AlwaysOn:
      return new AlwaysOnSampler();
    case TracesSamplerValues.AlwaysOff:
      return new AlwaysOffSampler();
    case TracesSamplerValues.ParentBasedAlwaysOn:
      return new ParentBasedSampler({
        root: new AlwaysOnSampler(),
      });
    case TracesSamplerValues.ParentBasedAlwaysOff:
      return new ParentBasedSampler({
        root: new AlwaysOffSampler(),
      });
    case TracesSamplerValues.TraceIdRatio:
      return new TraceIdRatioBasedSampler(getSamplerProbabilityFromEnv(environment));
    case TracesSamplerValues.ParentBasedTraceIdRatio:
      return new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(getSamplerProbabilityFromEnv(environment)),
      });
    default:
      diag.error(
        `OTEL_TRACES_SAMPLER value "${environment.OTEL_TRACES_SAMPLER} invalid, defaulting to ${FALLBACK_OTEL_TRACES_SAMPLER}".`
      );
      return new AlwaysOnSampler();
  }
}

function getSamplerProbabilityFromEnv(environment: Required<ENVIRONMENT>): number | undefined {
  if (environment.OTEL_TRACES_SAMPLER_ARG === undefined || environment.OTEL_TRACES_SAMPLER_ARG === '') {
    diag.error(`OTEL_TRACES_SAMPLER_ARG is blank, defaulting to ${DEFAULT_RATIO}.`);
    return DEFAULT_RATIO;
  }

  // eslint-disable-next-line @typescript-eslint/typedef
  const probability = Number(environment.OTEL_TRACES_SAMPLER_ARG);

  if (isNaN(probability)) {
    diag.error(
      `OTEL_TRACES_SAMPLER_ARG=${environment.OTEL_TRACES_SAMPLER_ARG} was given, but it is invalid, defaulting to ${DEFAULT_RATIO}.`
    );
    return DEFAULT_RATIO;
  }

  if (probability < 0 || probability > 1) {
    diag.error(
      `OTEL_TRACES_SAMPLER_ARG=${environment.OTEL_TRACES_SAMPLER_ARG} was given, but it is out of range ([0..1]), defaulting to ${DEFAULT_RATIO}.`
    );
    return DEFAULT_RATIO;
  }

  return probability;
}

function isLambdaEnvironment() {
  // detect if running in AWS Lambda environment
  return process.env[AWS_LAMBDA_FUNCTION_NAME_CONFIG] !== undefined;
}

function getXrayDaemonEndpoint() {
  return process.env[AWS_XRAY_DAEMON_ADDRESS_CONFIG];
}

// END The OpenTelemetry Authors code
