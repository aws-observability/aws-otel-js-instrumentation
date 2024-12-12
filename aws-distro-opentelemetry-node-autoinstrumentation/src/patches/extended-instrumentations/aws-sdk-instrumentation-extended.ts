// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { InstrumentationModuleDefinition, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { context, defaultTextMapSetter } from '@opentelemetry/api';
import { propwrap } from './../../third-party/otel/aws/propwrap';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';

const awsXrayPropagator = new AWSXRayPropagator();

// This class extends the upstream AwsInstrumentation to add an additional
// module instrumentation to patch `HttpRequest` of the `@smithy/protocol-http` module.
// This additional module instrumentation will replace HttpRequest with an extended version
// that injects the `X-Amzn-Trace-Id` HTTP header in the constructor so that aws-sdk-js-v3
// client calls can propagate the X-Ray trace context
export class AwsSdkInstrumentationExtended extends AwsInstrumentation {
  protected override init(): InstrumentationModuleDefinition[] {
    const instrumentationModuleDefinitions = super.init();

    const v3SmithyProtocolHttp = new InstrumentationNodeModuleDefinition(
      '@smithy/protocol-http',
      ['>=2.0.0'],
      (moduleExports: any) => {
        const newExports = propwrap(moduleExports, 'HttpRequest', (origHttpRequest: any) => {
          class ExtendedHttpRequest extends origHttpRequest {
            constructor(...args: any[]) {
              super(...args);
              awsXrayPropagator.inject(context.active(), this.headers, defaultTextMapSetter);
            }
          }

          return ExtendedHttpRequest;
        });

        return newExports;
      }
    );

    return [...instrumentationModuleDefinitions, v3SmithyProtocolHttp];
  }
}
