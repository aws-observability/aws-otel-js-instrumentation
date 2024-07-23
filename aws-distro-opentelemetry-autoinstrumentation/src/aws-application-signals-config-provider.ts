/*
 * Copyright Amazon.com, Inc. or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */
import { TextMapPropagator, diag } from '@opentelemetry/api';
import { getNodeAutoInstrumentations, getResourceDetectors } from '@opentelemetry/auto-instrumentations-node';
import { CompositePropagator, getEnv, getEnvWithoutDefaults } from '@opentelemetry/core';
import { OTLPMetricExporter as OTLPGrpcOTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { AggregationTemporalityPreference, OTLPMetricExporter as OTLPHttpOTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { Resource } from '@opentelemetry/resources';
import { Aggregation, AggregationSelector, InstrumentType, MeterProvider, PeriodicExportingMetricReader, PushMetricExporter } from '@opentelemetry/sdk-metrics';
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
import { AlwaysRecordSampler } from './always-record-sampler';
import { AttributePropagatingSpanProcessorBuilder } from './attribute-propagating-span-processor-builder';
import { AwsMetricAttributesSpanExporterBuilder } from './aws-metric-attributes-span-exporter-builder';
import { AwsSpanMetricsProcessorBuilder } from './aws-span-metrics-processor-builder';

const APPLICATION_SIGNALS_ENABLED_CONFIG: string = 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED';
const APP_SIGNALS_ENABLED_CONFIG: string = 'OTEL_AWS_APP_SIGNALS_ENABLED';
const APPLICATION_SIGNALS_EXPORTER_ENDPOINT_CONFIG: string = 'OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT';
const APP_SIGNALS_EXPORTER_ENDPOINT_CONFIG: string = 'OTEL_AWS_APP_SIGNALS_EXPORTER_ENDPOINT';
const METRIC_EXPORT_INTERVAL_CONFIG: string = 'OTEL_METRIC_EXPORT_INTERVAL';
const DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS: number = 60000;

export class AwsApplicationSignalsConfigProvider {
  private resource: Resource;
  private instrumentations: Instrumentation[];
  private idGenerator: IdGenerator;
  private sampler: Sampler;
  private spanProcessors: SpanProcessor[];

  constructor(resource: Resource, instrumentations?: Instrumentation[]) {
    this.resource = resource;
    this.instrumentations = instrumentations == undefined ? getNodeAutoInstrumentations() : instrumentations;

    // Not necessary anymore, consider removing entirely
    this.idGenerator = new AWSXRayIdGenerator();

    // if sampler env var is xray, use customized(xray sampler). Else...
    // consider removing sampler from returned config if app signals is not set
    this.sampler = this.customizeSampler(buildSamplerFromEnv());

    // default SpanProcessors with Span Exporters wrapped inside AwsMetricAttributesSpanExporter
    const awsSpanProcessorProvider: AwsSpanProcessorProvider = new AwsSpanProcessorProvider(this.resource, this.isApplicationSignalsEnabled());
    this.spanProcessors = awsSpanProcessorProvider.getSpanProcessors();
    this.customizeSpanProcessors();
  }

  private customizeSpanProcessors(): void {
    if (this.isApplicationSignalsEnabled()) {
      diag.info('AWS Application Signals enabled.');
    }

    let millis: string | undefined = process.env[METRIC_EXPORT_INTERVAL_CONFIG];
    if (millis == undefined) {
      millis = DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS.toString();
    }

    diag.debug(`AWS Application Signals Metrics export interval: ${millis}`);

    let exportIntervalMillis: number = Number(millis).valueOf();
    if (isNaN(exportIntervalMillis) || exportIntervalMillis.valueOf() > DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS) {
      exportIntervalMillis = DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS;

      diag.info(`AWS Application Signals metrics export interval capped to ${exportIntervalMillis}`);
    }

    this.spanProcessors.push(AttributePropagatingSpanProcessorBuilder.create().build());
    const otelMetricExporter: PushMetricExporter = ApplicationSignalsExporterProvider.Instance.createExporter();
    const periodicExportingMetricReader: PeriodicExportingMetricReader = new PeriodicExportingMetricReader({
      exporter: otelMetricExporter,
      exportIntervalMillis: exportIntervalMillis,
    });
    const meterProvider: MeterProvider = new MeterProvider({
      /** Resource associated with metric telemetry  */
      resource: this.resource,
      readers: [periodicExportingMetricReader],
    });
    this.spanProcessors.push(AwsSpanMetricsProcessorBuilder.create(meterProvider, this.resource).build());
  }

  public createConfig(): Partial<NodeSDKConfiguration> {
    let config: Partial<NodeSDKConfiguration>;
    if (this.isApplicationSignalsEnabled()) {
      // config.autoDetectResources is set to False, as the resources are detected and added to the
      // resource ahead of time. The resource is needed to be populated ahead of time instead of letting
      // the OTel Node SDK do the population work because the constructed resource was required to build
      // the sampler (if using XRay sampler) and the AwsMetricAttributesSpanExporter and AwsSpanMetricsProcessor
      config = {
        instrumentations: this.instrumentations,
        resource: this.resource,
        idGenerator: this.idGenerator,
        sampler: this.sampler,
        // Error message "Exporter "otlp" requested through environment variable is unavailable."
        // will appear from BasicTracerProvider that is used in the OTel JS SDK, even though the
        // span processors are specified
        // https://github.com/open-telemetry/opentelemetry-js/issues/3449
        spanProcessors: this.spanProcessors,
        autoDetectResources: false,
        textMapPropagator: AwsPropagatorProvider.buildPropagatorFromEnv(),
      };
    } else {
      // Default experience config
      config = {
        instrumentations: getNodeAutoInstrumentations(), //should be same as this.instrumentations, unless specified in constructor
        resourceDetectors: getResourceDetectors(),
      };
    }

    return config;
  }

  private isApplicationSignalsEnabled(): boolean {
    let isApplicationSignalsEnabled: string | undefined = process.env[APPLICATION_SIGNALS_ENABLED_CONFIG];
    if (isApplicationSignalsEnabled == undefined) {
      isApplicationSignalsEnabled = process.env[APP_SIGNALS_ENABLED_CONFIG];
    }
    return isApplicationSignalsEnabled == 'true';
  }

  private customizeSampler(sampler: Sampler): Sampler {
    if (this.isApplicationSignalsEnabled()) {
      return AlwaysRecordSampler.create(sampler);
    }
    return sampler;
  }

  // // moved to AwsSpanProcessorProvider
  // public static customizeSpanExporter(spanExporter: SpanExporter): SpanExporter {
  //   // if (isApplicationSignalsEnabled(configProps)) {
  //     return AwsMetricAttributesSpanExporterBuilder.create(spanExporter, this.resource).build();
  //   // }
  //   // return spanExporter;
  // }
}

class ApplicationSignalsExporterProvider {
  private static _instance: ApplicationSignalsExporterProvider;
  private constructor() {}
  public static get Instance() {
    return this._instance || (this._instance = new this());
  }

  public createExporter(): PushMetricExporter {
    let protocol: string | undefined = process.env['OTEL_EXPORTER_OTLP_METRICS_PROTOCOL'];
    if (protocol == undefined) {
      protocol = process.env['OTEL_EXPORTER_OTLP_PROTOCOL'];
    }
    if (protocol == undefined) {
      protocol = 'grpc';
    }

    diag.debug(`AWS Application Signals export protocol: ${protocol}`);

    const temporalityPreference: AggregationTemporalityPreference = AggregationTemporalityPreference.DELTA;
    const aggregationPreference: AggregationSelector = this.aggregationSelector;

    if (protocol == 'http/protobuf') {
      let applicationSignalsEndpoint: string | undefined = process.env[APPLICATION_SIGNALS_EXPORTER_ENDPOINT_CONFIG];
      if (applicationSignalsEndpoint == undefined) {
        applicationSignalsEndpoint = process.env[APP_SIGNALS_EXPORTER_ENDPOINT_CONFIG];
      }
      if (applicationSignalsEndpoint == undefined) {
        applicationSignalsEndpoint = 'http://localhost:4316/v1/metrics';
      }
      diag.debug(`AWS Application Signals export endpoint: ${applicationSignalsEndpoint}`);

      return new OTLPHttpOTLPMetricExporter({
        url: applicationSignalsEndpoint,
        temporalityPreference: temporalityPreference,
        aggregationPreference: aggregationPreference,
      });
    }
    if (protocol == 'grpc') {
      let applicationSignalsEndpoint: string | undefined = process.env[APPLICATION_SIGNALS_EXPORTER_ENDPOINT_CONFIG];
      if (applicationSignalsEndpoint == undefined) {
        applicationSignalsEndpoint = process.env[APP_SIGNALS_EXPORTER_ENDPOINT_CONFIG];
      }
      if (applicationSignalsEndpoint == undefined) {
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
        // TODO: Ensure this is equivalent to Java implementation
        // In Java, Aggregation.base2ExponentialBucketHistogram is used
        return Aggregation.ExponentialHistogram();
      }
    }
    return Aggregation.Default();
  };
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* 
This class is a modified version of TracerProviderWithEnvExporters (extends NodeTracerProvider), without
any of the TracerProvider functionalities. The AwsSpanProcessorProvider retains the functionality to
only create the default span processors with exporters specified in `OTEL_TRACES_EXPORTER`. These span
exporters are wrapped with AwsMetricAttributesSpanExporter when configuring the configureSpanProcessors

The original TracerProviderWithEnvExporters is not exported, so its useful static methods that
provides some default SpanExporter configurations are unavailable. Ideally we could get upstream
to export the TracerProviderWithEnvExporters
*/
class AwsSpanProcessorProvider {
  private _configuredExporters: SpanExporter[] = [];
  private _spanProcessors: SpanProcessor[] = [];
  private resource: Resource;
  private isApplicationSignalsEnabled: boolean;

  static configureOtlp(): SpanExporter {
    const protocol = this.getOtlpProtocol();

    switch (protocol) {
      case 'grpc':
        return new OTLPGrpcTraceExporter();
      case 'http/json':
        return new OTLPHttpTraceExporter();
      case 'http/protobuf':
        return new OTLPProtoTraceExporter();
      default:
        diag.warn(`Unsupported OTLP traces protocol: ${protocol}. Using http/protobuf.`);
        return new OTLPProtoTraceExporter();
    }
  }

  static getOtlpProtocol(): string {
    const parsedEnvValues = getEnvWithoutDefaults();

    return parsedEnvValues.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? parsedEnvValues.OTEL_EXPORTER_OTLP_PROTOCOL ?? getEnv().OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? getEnv().OTEL_EXPORTER_OTLP_PROTOCOL;
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

  public constructor(resource: Resource, isApplicationSignalsEnabled: boolean) {
    this.resource = resource;
    this.isApplicationSignalsEnabled = isApplicationSignalsEnabled;

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
      const exporter = this._getSpanExporter(exporterName);
      if (exporter) {
        this._configuredExporters.push(exporter);
      } else {
        diag.warn(`Unrecognized OTEL_TRACES_EXPORTER value: ${exporterName}.`);
      }
    });
  }

  protected _getSpanExporter(name: string): SpanExporter | undefined {
    return (this.constructor as typeof AwsSpanProcessorProvider)._registeredExporters.get(name)?.();
  }

  private configureSpanProcessors(exporters: SpanExporter[]): (BatchSpanProcessor | SimpleSpanProcessor)[] {
    return exporters.map(exporter => {
      const wrappedExporter: SpanExporter = this.customizeSpanExporter(exporter);
      if (exporter instanceof ConsoleSpanExporter) {
        return new SimpleSpanProcessor(wrappedExporter);
      } else {
        return new BatchSpanProcessor(wrappedExporter);
      }
    });
  }

  private filterBlanksAndNulls(list: string[]): string[] {
    return list.map(item => item.trim()).filter(s => s !== 'null' && s !== '');
  }

  private customizeSpanExporter(spanExporter: SpanExporter): SpanExporter {
    if (this.isApplicationSignalsEnabled) {
      return AwsMetricAttributesSpanExporterBuilder.create(spanExporter, this.resource).build();
    }
    return spanExporter;
  }

  public getSpanProcessors(): SpanProcessor[] {
    return this._spanProcessors;
  }
}

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ENVIRONMENT, TracesSamplerValues } from '@opentelemetry/core';

const FALLBACK_OTEL_TRACES_SAMPLER: string = TracesSamplerValues.AlwaysOn;
const DEFAULT_RATIO: number = 1;

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
      diag.error(`OTEL_TRACES_SAMPLER value "${environment.OTEL_TRACES_SAMPLER} invalid, defaulting to ${FALLBACK_OTEL_TRACES_SAMPLER}".`);
      return new AlwaysOnSampler();
  }
}

function getSamplerProbabilityFromEnv(environment: Required<ENVIRONMENT>): number | undefined {
  if (environment.OTEL_TRACES_SAMPLER_ARG === undefined || environment.OTEL_TRACES_SAMPLER_ARG === '') {
    diag.error(`OTEL_TRACES_SAMPLER_ARG is blank, defaulting to ${DEFAULT_RATIO}.`);
    return DEFAULT_RATIO;
  }

  const probability = Number(environment.OTEL_TRACES_SAMPLER_ARG);

  if (isNaN(probability)) {
    diag.error(`OTEL_TRACES_SAMPLER_ARG=${environment.OTEL_TRACES_SAMPLER_ARG} was given, but it is invalid, defaulting to ${DEFAULT_RATIO}.`);
    return DEFAULT_RATIO;
  }

  if (probability < 0 || probability > 1) {
    diag.error(`OTEL_TRACES_SAMPLER_ARG=${environment.OTEL_TRACES_SAMPLER_ARG} was given, but it is out of range ([0..1]), defaulting to ${DEFAULT_RATIO}.`);
    return DEFAULT_RATIO;
  }

  return probability;
}

import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { PROPAGATOR_FACTORY } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

//[][][]
// Make use of NodeTracerProvider specifically to make use of the registeredPropagators in order to
// extend it to include the X-Ray Propagator and to obtain the propagators via specified Env Var.
class AwsPropagatorProvider extends NodeTracerProvider {
  protected static override readonly _registeredPropagators = new Map<string, PROPAGATOR_FACTORY>([...NodeTracerProvider._registeredPropagators, ['xray', () => new AWSXRayPropagator()]]);

  protected static getPropagator(name: string): TextMapPropagator | undefined {
    return this._registeredPropagators.get(name)?.();
  }

  public static buildPropagatorFromEnv(): TextMapPropagator | undefined {
    // per spec, propagators from env must be deduplicated
    const uniquePropagatorNames: string[] = Array.from(new Set(getEnv().OTEL_PROPAGATORS));

    const propagators = uniquePropagatorNames.map(name => {
      const propagator = this.getPropagator(name);
      if (!propagator) {
        diag.warn(`Propagator "${name}" requested through environment variable is unavailable.`);
      }

      return propagator;
    });
    const validPropagators: TextMapPropagator[] = propagators.reduce<TextMapPropagator[]>((list, item) => {
      if (item) {
        list.push(item);
      }
      return list;
    }, []);

    if (validPropagators.length === 0) {
      return;
    } else if (uniquePropagatorNames.length === 1) {
      return validPropagators[0];
    } else {
      return new CompositePropagator({
        propagators: validPropagators,
      });
    }
  }
}
