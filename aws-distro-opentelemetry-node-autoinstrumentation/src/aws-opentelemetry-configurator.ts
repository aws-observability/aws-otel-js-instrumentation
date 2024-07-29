//Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { awsEc2Detector, awsEcsDetector, awsEksDetector } from '@opentelemetry/resource-detector-aws';
import {
  Detector,
  DetectorSync,
  Resource,
  ResourceDetectionConfig,
  detectResourcesSync,
  envDetectorSync,
} from '@opentelemetry/resources';
import { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { SEMRESATTRS_TELEMETRY_AUTO_VERSION } from '@opentelemetry/semantic-conventions';

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

  constructor() {
    /*
     * Set and Detect Resources via Resource Detectors
     *
     * The configurator must create and detect resources in order to populate any detected
     * resources into the Resource that is provided to the processors, exporters, and samplers
     * that are instantiated in the configurator. Otherwise, if only OTel handles resource
     * detection in the SDK, the AWS processors/exporters/samplers will lack such detected
     * resources in their respective resources.
     *
     * envDetectorSync is used as opposed to envDetector (async), so it is guaranteed that the
     * resource is populated with configured OTEL_RESOURCE_ATTRIBUTES or OTEL_SERVICE_NAME env
     * var values by the time that this class provides a configuration to the OTel SDK.
     */
    const resourceDetectors: (Detector | DetectorSync)[] = [
      envDetectorSync,
      awsEc2Detector,
      awsEcsDetector,
      awsEksDetector,
    ];
    const internalConfig: ResourceDetectionConfig = {
      detectors: resourceDetectors,
    };
    let autoResource: Resource = new Resource({});
    autoResource = this.customizeVersions(autoResource);
    autoResource = autoResource.merge(detectResourcesSync(internalConfig));
    this.resource = autoResource;
  }

  private customizeVersions(autoResource: Resource): Resource {
    // eslint-disable-next-line @typescript-eslint/typedef
    const packageJson = require('./../../package.json');
    const LIB_VERSION: string = packageJson.version;
    autoResource.attributes[SEMRESATTRS_TELEMETRY_AUTO_VERSION] = LIB_VERSION + '-sdk';
    diag.debug(
      `@aws/aws-distro-opentelemetry-node-autoinstrumentation - version: ${autoResource.attributes[SEMRESATTRS_TELEMETRY_AUTO_VERSION]}`
    );
    return autoResource;
  }

  public configure(): Partial<NodeSDKConfiguration> {
    let config: Partial<NodeSDKConfiguration>;
    if (this.isApplicationSignalsEnabled()) {
      // Placeholder config
      config = {
        instrumentations: getNodeAutoInstrumentations(),
        resource: this.resource,
      };
    } else {
      // Default experience config
      config = {
        instrumentations: getNodeAutoInstrumentations(),
        resource: this.resource,
      };
    }

    return config;
  }

  private isApplicationSignalsEnabled(): boolean {
    const isApplicationSignalsEnabled: string | undefined = process.env[APPLICATION_SIGNALS_ENABLED_CONFIG];
    if (isApplicationSignalsEnabled === undefined) {
      return false;
    }

    return isApplicationSignalsEnabled.toLowerCase() === 'true';
  }
}
