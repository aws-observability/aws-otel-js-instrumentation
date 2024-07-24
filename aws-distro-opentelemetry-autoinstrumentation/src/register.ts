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

import { DiagConsoleLogger, diag } from '@opentelemetry/api';
import { awsEc2Detector, awsEcsDetector, awsEksDetector } from '@opentelemetry/resource-detector-aws';
import { Detector, DetectorSync, Resource, ResourceDetectionConfig, detectResourcesSync, envDetectorSync } from '@opentelemetry/resources';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SEMRESATTRS_TELEMETRY_AUTO_VERSION } from '@opentelemetry/semantic-conventions';
import { AwsApplicationSignalsConfigProvider } from './aws-application-signals-config-provider';

// `./version` is generated from `./../package.json` via `npm run compile`
import { LIB_VERSION } from './version';

diag.setLogger(new DiagConsoleLogger(), opentelemetry.core.getEnv().OTEL_LOG_LEVEL);

if (!process.env.OTEL_EXPORTER_OTLP_PROTOCOL) {
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
}
if (!process.env.OTEL_PROPAGATORS) {
  process.env.OTEL_PROPAGATORS = 'xray,tracecontext,b3,b3multi';
}

/*
 * Set Resource Detectors
 */
const resourceDetectors: (Detector | DetectorSync)[] = [envDetectorSync, awsEc2Detector, awsEcsDetector, awsEksDetector];
let autoResource: Resource = new Resource({
  [SEMRESATTRS_TELEMETRY_AUTO_VERSION]: LIB_VERSION + '-sdk',
});
const internalConfig: ResourceDetectionConfig = {
  detectors: resourceDetectors,
};
autoResource = autoResource.merge(detectResourcesSync(internalConfig));

const otelNodeSdkConfigProvider: AwsApplicationSignalsConfigProvider = new AwsApplicationSignalsConfigProvider(autoResource);
const otelNodeSdkConfig: Partial<opentelemetry.NodeSDKConfiguration> = otelNodeSdkConfigProvider.createConfig();

const sdk: opentelemetry.NodeSDK = new opentelemetry.NodeSDK(otelNodeSdkConfig);

// Below is the OpenTelemetry Authors code
try {
  sdk.start();
  diag.info('AWS Distro OpenTelemetry automatic instrumentation started successfully');
} catch (error) {
  diag.error('Error initializing OpenTelemetry SDK. Your application is not instrumented and will not produce telemetry', error);
}

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .then(() => diag.debug('OpenTelemetry SDK terminated'))
    .catch(error => diag.error('Error terminating OpenTelemetry SDK', error));
});
