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
import { getNodeAutoInstrumentations, getResourceDetectors } from '@opentelemetry/auto-instrumentations-node';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { Resource } from '@opentelemetry/resources';
import { NodeSDKConfiguration } from '@opentelemetry/sdk-node';

const APPLICATION_SIGNALS_ENABLED_CONFIG: string = 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED';
const APP_SIGNALS_ENABLED_CONFIG: string = 'OTEL_AWS_APP_SIGNALS_ENABLED';

export class AwsApplicationSignalsConfigProvider {
  // private resource: Resource;
  // private instrumentations: Instrumentation[];
  // private idGenerator: IdGenerator;
  // private sampler: Sampler;
  // private spanProcessors: SpanProcessor[];

  constructor(resource: Resource, instrumentations?: Instrumentation[]) {
    // TODO
  }

  private customizeSpanProcessors(): void {
    // TODO
  }

  public createConfig(): Partial<NodeSDKConfiguration> {
    let config: Partial<NodeSDKConfiguration>;
    if (this.isApplicationSignalsEnabled()) {
      // Placeholder config
      config = {
        instrumentations: getNodeAutoInstrumentations(),
        resourceDetectors: getResourceDetectors(),
      };
    } else {
      // Default experience config
      config = {
        instrumentations: getNodeAutoInstrumentations(),
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
}
