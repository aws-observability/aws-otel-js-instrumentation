//Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
//SPDX-License-Identifier: Apache-2.0

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
