// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import {
  getNodeAutoInstrumentations,
  getResourceDetectors as getResourceDetectorsFromEnv,
} from '@opentelemetry/auto-instrumentations-node';
import { ENVIRONMENT, TracesSamplerValues, getEnv } from '@opentelemetry/core';
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
import { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  Sampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { SEMRESATTRS_TELEMETRY_AUTO_VERSION } from '@opentelemetry/semantic-conventions';
import { AlwaysRecordSampler } from './always-record-sampler';
import { AwsXRayRemoteSampler } from './sampler/src';

const APPLICATION_SIGNALS_ENABLED_CONFIG: string = 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED';

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
  private sampler: Sampler;

  constructor() {
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
       */
      defaultDetectors = [
        envDetectorSync,
        processDetector,
        hostDetector,
        awsEc2Detector,
        awsEcsDetector,
        awsEksDetector,
      ];
    }

    const internalConfig: ResourceDetectionConfig = {
      detectors: defaultDetectors,
    };

    autoResource = autoResource.merge(detectResourcesSync(internalConfig));

    this.resource = autoResource;

    this.sampler = AwsOpentelemetryConfigurator.customizeSampler(customBuildSamplerFromEnv(this.resource));
  }

  private customizeVersions(autoResource: Resource): Resource {
    // eslint-disable-next-line @typescript-eslint/typedef
    const packageJson = require('./../../package.json');
    const DISTRO_VERSION: string = packageJson.version;
    autoResource.attributes[SEMRESATTRS_TELEMETRY_AUTO_VERSION] = DISTRO_VERSION + '-aws';
    diag.debug(
      `@aws/aws-distro-opentelemetry-node-autoinstrumentation - version: ${autoResource.attributes[SEMRESATTRS_TELEMETRY_AUTO_VERSION]}`
    );
    return autoResource;
  }

  public configure(): Partial<NodeSDKConfiguration> {
    let config: Partial<NodeSDKConfiguration>;
    if (AwsOpentelemetryConfigurator.isApplicationSignalsEnabled()) {
      // TODO: This is a placeholder config. This will be replaced with an ADOT config in a future commit.
      config = {
        instrumentations: getNodeAutoInstrumentations(),
        resource: this.resource,
        sampler: this.sampler,
        autoDetectResources: false,
      };
    } else {
      // Default experience config
      config = {
        instrumentations: getNodeAutoInstrumentations(),
        resource: this.resource,
        sampler: this.sampler,
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
          const keyValue: string[] = arg.split('=', 2);
          if (keyValue.length !== 2) {
            continue;
          }
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

// The OpenTelemetry Authors code
//
// We need the logic to build the Sampler from user-defined Environment variables in order
// to wrap the Sampler with an AlwaysRecord sampler. However, this logic is not exported
// in an `index.ts` file, so this code needs to be added here.
//
// TODO: Ideally, upstream's `buildSamplerFromEnv()` method should be exported
//
// An alternative method is to instantiate a new OTel JS Tracer with an empty config, which
// would also have the (private+readonly) sampler from the `buildSamplerFromEnv()` method.
// https://github.com/open-telemetry/opentelemetry-js/blob/01cea7caeb130142cc017f77ea74834a35d0e8d6/packages/opentelemetry-sdk-trace-base/src/Tracer.ts#L36-L53

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
