// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { context as otelContext, defaultTextMapSetter } from '@opentelemetry/api';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import type { Command as AwsV3Command } from '@aws-sdk/types';

const awsXrayPropagator = new AWSXRayPropagator();
const V3_CLIENT_CONFIG_KEY = Symbol('opentelemetry.instrumentation.aws-sdk.client.config');
type V3PluginCommand = AwsV3Command<any, any, any, any, any> & {
  [V3_CLIENT_CONFIG_KEY]?: any;
};

// This class extends the upstream AwsInstrumentation to override its patching mechanism of the `send` method.
// The overriden method will additionally update the AWS SDK middleware stack to inject the `X-Amzn-Trace-Id` HTTP header.
//
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
export class AwsSdkInstrumentationExtended extends AwsInstrumentation {
  // Override the upstream private _getV3SmithyClientSendPatch method to add middleware to inject X-Ray Trace Context into HTTP Headers
  // https://github.com/open-telemetry/opentelemetry-js-contrib/blob/instrumentation-aws-sdk-v0.48.0/plugins/node/opentelemetry-instrumentation-aws-sdk/src/aws-sdk.ts#L373-L384
  override _getV3SmithyClientSendPatch(original: (...args: unknown[]) => Promise<any>) {
    return function send(this: any, command: V3PluginCommand, ...args: unknown[]): Promise<any> {
      this.middlewareStack?.add(
        (next: any, context: any) => async (middlewareArgs: any) => {
          awsXrayPropagator.inject(otelContext.active(), middlewareArgs.request.headers, defaultTextMapSetter);
          const result = await next(middlewareArgs);
          return result;
        },
        {
          step: 'build',
          name: '_adotInjectXrayContextMiddleware',
          override: true,
        }
      );

      command[V3_CLIENT_CONFIG_KEY] = this.config;
      return original.apply(this, [command, ...args]);
    };
  }
}
