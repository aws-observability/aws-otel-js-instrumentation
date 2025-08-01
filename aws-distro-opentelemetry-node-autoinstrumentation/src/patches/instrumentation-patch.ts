// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  diag,
  isSpanContextValid,
  Context as OtelContext,
  context as otelContext,
  propagation,
  ROOT_CONTEXT,
  TextMapGetter,
  trace,
  Span,
  Tracer,
  SpanStatusCode,
  defaultTextMapSetter,
} from '@opentelemetry/api';
import { Instrumentation } from '@opentelemetry/instrumentation';
import {
  AwsInstrumentation,
  AwsSdkInstrumentationConfig,
  NormalizedRequest,
  NormalizedResponse,
} from '@opentelemetry/instrumentation-aws-sdk';
import { AWSXRAY_TRACE_ID_HEADER, AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { APIGatewayProxyEventHeaders, Context } from 'aws-lambda';
import { AWS_ATTRIBUTE_KEYS } from '../aws-attribute-keys';
import { RequestMetadata } from '../third-party/otel/aws/services/ServiceExtension';
import {
  BedrockAgentRuntimeServiceExtension,
  BedrockAgentServiceExtension,
  BedrockRuntimeServiceExtension,
  BedrockServiceExtension,
} from './aws/services/bedrock';
import { SecretsManagerServiceExtension } from './aws/services/secretsmanager';
import { StepFunctionsServiceExtension } from './aws/services/step-functions';
import type { AwsLambdaInstrumentation } from '@opentelemetry/instrumentation-aws-lambda';
import type { Command as AwsV3Command } from '@aws-sdk/types';
import { LoggerProvider } from '@opentelemetry/api-logs';
import { suppressTracing } from '@opentelemetry/core';

export const traceContextEnvironmentKey = '_X_AMZN_TRACE_ID';
export const AWSXRAY_TRACE_ID_HEADER_CAPITALIZED = 'X-Amzn-Trace-Id';

const awsPropagator = new AWSXRayPropagator();
export const headerGetter: TextMapGetter<APIGatewayProxyEventHeaders> = {
  keys(carrier: any): string[] {
    return Object.keys(carrier);
  },
  get(carrier: any, key: string) {
    return carrier[key];
  },
};

export function applyInstrumentationPatches(instrumentations: Instrumentation[]): void {
  /*
  Apply patches to upstream instrumentation libraries.

  This method is invoked to apply changes to upstream instrumentation libraries, typically when changes to upstream
  are required on a timeline that cannot wait for upstream release. Generally speaking, patches should be short-term
  local solutions that are comparable to long-term upstream solutions.

  Where possible, automated testing should be run to catch upstream changes resulting in broken patches
  */
  instrumentations.forEach((instrumentation, index) => {
    if (instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-sdk') {
      diag.debug('Patching aws sdk instrumentation');
      patchAwsSdkInstrumentation(instrumentation);

      // Access private property servicesExtensions of AwsInstrumentation
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const services: Map<string, ServiceExtension> | undefined = (instrumentations[index] as any).servicesExtensions
        ?.services;
      if (services) {
        services.set('SecretsManager', new SecretsManagerServiceExtension());
        services.set('SFN', new StepFunctionsServiceExtension());
        services.set('Bedrock', new BedrockServiceExtension());
        services.set('BedrockAgent', new BedrockAgentServiceExtension());
        services.set('BedrockAgentRuntime', new BedrockAgentRuntimeServiceExtension());
        services.set('BedrockRuntime', new BedrockRuntimeServiceExtension());
        patchSqsServiceExtension(services.get('SQS'));
        patchSnsServiceExtension(services.get('SNS'));
        patchLambdaServiceExtension(services.get('Lambda'));
        patchKinesisServiceExtension(services.get('Kinesis'));
        patchDynamoDbServiceExtension(services.get('DynamoDB'));
      }
    } else if (instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-lambda') {
      diag.debug('Patching aws lambda instrumentation');
      patchAwsLambdaInstrumentation(instrumentation);
    }
  });
}

/*
 * This function `customExtractor` is used to extract SpanContext for AWS Lambda functions.
 * It first attempts to extract the trace context from the AWS X-Ray header, which is stored in the Lambda environment variables.
 * If a valid span context is extracted from the environment, it uses this as the parent context for the function's tracing.
 * If the X-Ray header is missing or invalid, it falls back to extracting trace context from the Lambda handler's event headers.
 * If neither approach succeeds, it defaults to using the root Otel context, ensuring the function is still instrumented for tracing.
 */
export const customExtractor = (event: any, _handlerContext: Context): OtelContext => {
  let parent: OtelContext | undefined = undefined;
  const lambdaTraceHeader = process.env[traceContextEnvironmentKey];
  if (lambdaTraceHeader) {
    parent = awsPropagator.extract(
      otelContext.active(),
      { [AWSXRAY_TRACE_ID_HEADER]: lambdaTraceHeader },
      headerGetter
    );
  }
  if (parent) {
    const spanContext = trace.getSpan(parent)?.spanContext();
    if (spanContext && isSpanContextValid(spanContext)) {
      return parent;
    }
  }
  const httpHeaders = event.headers || {};
  const extractedContext = propagation.extract(otelContext.active(), httpHeaders, headerGetter);
  if (trace.getSpan(extractedContext)?.spanContext()) {
    return extractedContext;
  }
  return ROOT_CONTEXT;
};

/*
 * This patch extends the existing upstream extension for SQS. Extensions allow for custom logic for adding
 * service-specific information to spans, such as attributes. Specifically, we are adding logic to add
 * `aws.sqs.queue.url` and `aws.sqs.queue.name` attributes, to be used to generate RemoteTarget and achieve parity
 * with the Java/Python instrumentation.
 *
 * Callout that today, the upstream logic adds `messaging.url` and `messaging.destination` but we feel that
 * `aws.sqs` is more in line with existing AWS Semantic Convention attributes like `AWS_S3_BUCKET`, etc.
 *
 * @param sqsServiceExtension SQS Service Extension obtained the service extension list from the AWS SDK OTel Instrumentation
 */
function patchSqsServiceExtension(sqsServiceExtension: any): void {
  // It is not expected that `sqsServiceExtension` is undefined
  if (sqsServiceExtension) {
    const requestPreSpanHook = sqsServiceExtension.requestPreSpanHook;
    // Save original `requestPreSpanHook` under a similar name, to be invoked by the patched hook
    sqsServiceExtension._requestPreSpanHook = requestPreSpanHook;
    // The patched hook will populate the 'aws.sqs.queue.url' and 'aws.sqs.queue.name' attributes according to spec
    // from the 'messaging.url' attribute
    const patchedRequestPreSpanHook = (
      request: NormalizedRequest,
      _config: AwsSdkInstrumentationConfig
    ): RequestMetadata => {
      const requestMetadata: RequestMetadata = sqsServiceExtension._requestPreSpanHook(request, _config);
      // It is not expected that `requestMetadata.spanAttributes` can possibly be undefined, but still be careful anyways
      if (requestMetadata.spanAttributes) {
        if (request.commandInput?.QueueUrl) {
          requestMetadata.spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL] = request.commandInput.QueueUrl;
        }
        if (request.commandInput?.QueueName) {
          requestMetadata.spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME] = request.commandInput.QueueName;
        }
      }
      return requestMetadata;
    };
    sqsServiceExtension.requestPreSpanHook = patchedRequestPreSpanHook;
  }
}

/*
 * This patch extends the existing upstream extension for SNS. Extensions allow for custom logic for adding
 * service-specific information to spans, such as attributes. Specifically, we are adding logic to add
 * `aws.sns.topic.arn` attribute, to be used to generate RemoteTarget and achieve parity with the Java/Python instrumentation.
 *
 *
 * @param snsServiceExtension SNS Service Extension obtained the service extension list from the AWS SDK OTel Instrumentation
 */
function patchSnsServiceExtension(snsServiceExtension: any): void {
  if (snsServiceExtension) {
    const requestPreSpanHook = snsServiceExtension.requestPreSpanHook;
    snsServiceExtension._requestPreSpanHook = requestPreSpanHook;

    const patchedRequestPreSpanHook = (
      request: NormalizedRequest,
      _config: AwsSdkInstrumentationConfig
    ): RequestMetadata => {
      const requestMetadata: RequestMetadata = snsServiceExtension._requestPreSpanHook(request, _config);
      if (requestMetadata.spanAttributes) {
        const topicArn = request.commandInput?.TopicArn;
        if (topicArn) {
          requestMetadata.spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_SNS_TOPIC_ARN] = topicArn;
        }
      }
      return requestMetadata;
    };

    snsServiceExtension.requestPreSpanHook = patchedRequestPreSpanHook;
  }
}

/*
 * This patch extends the existing upstream extension for Kinesis. Extensions allow for custom logic for adding
 * service-specific information to spans, such as attributes. Specifically, we are adding logic to add
 * `aws.kinesis.stream.arn` attribute, to be used to generate RemoteTarget and achieve parity with the Java/Python instrumentation.
 *
 *
 * @param kinesisServiceExtension Kinesis Service Extension obtained the service extension list from the AWS SDK OTel Instrumentation
 */
function patchKinesisServiceExtension(kinesisServiceExtension: any): void {
  if (kinesisServiceExtension) {
    const requestPreSpanHook = kinesisServiceExtension.requestPreSpanHook;
    kinesisServiceExtension._requestPreSpanHook = requestPreSpanHook;

    const patchedRequestPreSpanHook = (
      request: NormalizedRequest,
      _config: AwsSdkInstrumentationConfig
    ): RequestMetadata => {
      const requestMetadata: RequestMetadata = kinesisServiceExtension._requestPreSpanHook(request, _config);
      if (requestMetadata.spanAttributes) {
        const streamArn = request.commandInput?.StreamARN;
        if (streamArn) {
          requestMetadata.spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_ARN] = streamArn;
        }
      }
      return requestMetadata;
    };

    kinesisServiceExtension.requestPreSpanHook = patchedRequestPreSpanHook;
  }
}

/*
 * This patch extends the existing upstream extension for DynamoDB. Extensions allow for custom logic for adding
 * service-specific information to spans, such as attributes. Specifically, we are adding logic to add
 * `aws.dynamodb.table.arn` attribute, to be used to generate RemoteTarget and achieve parity with the Java/Python instrumentation.
 *
 *
 * @param dynamoDbServiceExtension DynamoDB Service Extension obtained the service extension list from the AWS SDK OTel Instrumentation
 */
function patchDynamoDbServiceExtension(dynamoDbServiceExtension: any): void {
  if (dynamoDbServiceExtension) {
    if (typeof dynamoDbServiceExtension.responseHook === 'function') {
      const responseHook = dynamoDbServiceExtension.responseHook;

      const patchedResponseHook = (
        response: NormalizedResponse,
        span: Span,
        tracer: Tracer,
        config: AwsSdkInstrumentationConfig
      ): void => {
        responseHook.call(dynamoDbServiceExtension, response, span, tracer, config);

        const tableArn = response?.data?.Table?.TableArn;
        if (tableArn) {
          span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_ARN, tableArn);
        }
      };

      dynamoDbServiceExtension.responseHook = patchedResponseHook;
    }
  }
}

/*
 * This patch extends the existing upstream extension for Lambda. Extensions allow for custom logic for adding
 * service-specific information to spans, such as attributes. Specifically, we are adding logic to add
 * `aws.lambda.resource_mapping.id` attribute, to be used to generate RemoteTarget and achieve parity with the Java/Python instrumentation.
 *
 *
 * @param lambdaServiceExtension Lambda Service Extension obtained the service extension list from the AWS SDK OTel Instrumentation
 */
function patchLambdaServiceExtension(lambdaServiceExtension: any): void {
  if (lambdaServiceExtension) {
    const requestPreSpanHook = lambdaServiceExtension.requestPreSpanHook;
    lambdaServiceExtension._requestPreSpanHook = requestPreSpanHook;

    const patchedRequestPreSpanHook = (
      request: NormalizedRequest,
      _config: AwsSdkInstrumentationConfig
    ): RequestMetadata => {
      const requestMetadata: RequestMetadata = lambdaServiceExtension._requestPreSpanHook(request, _config);
      if (requestMetadata.spanAttributes) {
        const resourceMappingId = request.commandInput?.UUID;
        if (resourceMappingId) {
          requestMetadata.spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_RESOURCE_MAPPING_ID] = resourceMappingId;
        }

        const requestFunctionNameFormat = request.commandInput?.FunctionName;
        let functionName = requestFunctionNameFormat;

        if (requestFunctionNameFormat) {
          if (requestFunctionNameFormat.startsWith('arn:aws:lambda')) {
            const split = requestFunctionNameFormat.split(':');
            functionName = split[split.length - 1];
          }
          requestMetadata.spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME] = functionName;
        }
      }
      return requestMetadata;
    };

    lambdaServiceExtension.requestPreSpanHook = patchedRequestPreSpanHook;

    if (typeof lambdaServiceExtension.responseHook === 'function') {
      const originalResponseHook = lambdaServiceExtension.responseHook;

      lambdaServiceExtension.responseHook = (
        response: NormalizedResponse,
        span: Span,
        tracer: Tracer,
        config: AwsSdkInstrumentationConfig
      ): void => {
        originalResponseHook.call(lambdaServiceExtension, response, span, tracer, config);

        if (response.data && response.data.Configuration) {
          const functionArn = response.data.Configuration.FunctionArn;
          if (functionArn) {
            span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_ARN, functionArn);
          }
        }
      };
    }
  }
}

export type ExtendedAwsLambdaInstrumentation = AwsLambdaInstrumentation & {
  _setLoggerProvider: (loggerProvider: LoggerProvider) => void;
  _logForceFlusher?: () => Promise<void>;
  _logForceFlush: (loggerProvider: LoggerProvider) => any;
};

// Patch AWS Lambda Instrumentation
// 1. Override the upstream private _endSpan method to remove the unnecessary metric force-flush error message
//    https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/plugins/node/opentelemetry-instrumentation-aws-lambda/src/instrumentation.ts#L358-L398
// 2. Support setting logger provider and force flushing logs
function patchAwsLambdaInstrumentation(instrumentation: Instrumentation): void {
  if (instrumentation) {
    const _setLoggerProvider = (instrumentation as ExtendedAwsLambdaInstrumentation)['setLoggerProvider'];
    (instrumentation as ExtendedAwsLambdaInstrumentation)['_setLoggerProvider'] = _setLoggerProvider;
    (instrumentation as ExtendedAwsLambdaInstrumentation)['_logForceFlusher'] = undefined;

    instrumentation['setLoggerProvider'] = function (loggerProvider: LoggerProvider) {
      (this as ExtendedAwsLambdaInstrumentation)['_setLoggerProvider'](loggerProvider);
      (this as ExtendedAwsLambdaInstrumentation)['_logForceFlusher'] = (this as ExtendedAwsLambdaInstrumentation)[
        '_logForceFlush'
      ](loggerProvider);
    };

    (instrumentation as ExtendedAwsLambdaInstrumentation)['_logForceFlush'] = function (
      loggerProvider: LoggerProvider
    ) {
      if (!loggerProvider) return undefined;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let currentProvider: any = loggerProvider;

      if (typeof currentProvider.getDelegate === 'function') {
        currentProvider = currentProvider.getDelegate();
      }

      if (typeof currentProvider.forceFlush === 'function') {
        return currentProvider.forceFlush.bind(currentProvider);
      }

      return undefined;
    };

    (instrumentation as ExtendedAwsLambdaInstrumentation)['_endSpan'] = function (
      span: Span,
      err: string | Error | null | undefined,
      callback: () => void
    ) {
      if (err) {
        span.recordException(err);
      }

      let errMessage;
      if (typeof err === 'string') {
        errMessage = err;
      } else if (err) {
        errMessage = err.message;
      }
      if (errMessage) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errMessage,
        });
      }

      span.end();

      const flushers = [];
      if (this['_traceForceFlusher']) {
        flushers.push(this['_traceForceFlusher']());
      } else {
        diag.error(
          'Spans may not be exported for the lambda function because we are not force flushing before callback.'
        );
      }
      if (this['_metricForceFlusher']) {
        flushers.push(this['_metricForceFlusher']());
      } else {
        diag.debug(
          'Metrics may not be exported for the lambda function because we are not force flushing before callback.'
        );
      }
      if (this['_logForceFlusher']) {
        flushers.push(this['_logForceFlusher']());
      } else {
        diag.debug(
          'Logs may not be exported for the lambda function because we are not force flushing before callback.'
        );
      }

      Promise.all(flushers).then(callback, callback);
    };
  }
}

// Override the upstream private _getV3SmithyClientSendPatch method to add middlewares to inject X-Ray Trace Context into HTTP Headers and to extract account access key id and region for cross-account support
// https://github.com/open-telemetry/opentelemetry-js-contrib/blob/instrumentation-aws-sdk-v0.48.0/plugins/node/opentelemetry-instrumentation-aws-sdk/src/aws-sdk.ts#L373-L384
const V3_CLIENT_CONFIG_KEY = Symbol('opentelemetry.instrumentation.aws-sdk.client.config');
type V3PluginCommand = AwsV3Command<any, any, any, any, any> & {
  [V3_CLIENT_CONFIG_KEY]?: any;
};
// Symbol to prevent infinite recursion during credential capture
// When we extract credentials, the AWS SDK may need to make additional AWS API calls
// (e.g., sts:AssumeRoleWithWebIdentity) which go through the same instrumented 'send' method.
// Without this flag, each credential request would trigger another credential extraction attempt,
// creating an infinite loop of nested AWS SDK calls.
export const SKIP_CREDENTIAL_CAPTURE_KEY = Symbol('skip-credential-capture');
function patchAwsSdkInstrumentation(instrumentation: Instrumentation): void {
  if (instrumentation) {
    (instrumentation as AwsInstrumentation)['_getV3SmithyClientSendPatch'] = function (
      original: (...args: unknown[]) => Promise<any>
    ) {
      return function send(this: any, command: V3PluginCommand, ...args: unknown[]): Promise<any> {
        // Only add middleware once per client instance to reduce overhead
        // AWS SDK clients may call 'send' multiple times, but we only need to patch once
        // Even with override=true, adding middleware still causes overhead as it replaces existing stack entries
        if (!this.__adotMiddlewarePatched) {
          this.middlewareStack?.add(
            (next: any, context: any) => async (middlewareArgs: any) => {
              propagation.inject(otelContext.active(), middlewareArgs.request.headers, defaultTextMapSetter);
              // Need to set capitalized version of the trace id to ensure that the Recursion Detection Middleware
              // of aws-sdk-js-v3 will detect the propagated X-Ray Context
              // See: https://github.com/aws/aws-sdk-js-v3/blob/v3.768.0/packages/middleware-recursion-detection/src/index.ts#L13
              const xrayTraceId = middlewareArgs.request.headers[AWSXRAY_TRACE_ID_HEADER];

              if (xrayTraceId) {
                middlewareArgs.request.headers[AWSXRAY_TRACE_ID_HEADER_CAPITALIZED] = xrayTraceId;
                delete middlewareArgs.request.headers[AWSXRAY_TRACE_ID_HEADER];
              }
              const result = await next(middlewareArgs);
              return result;
            },
            {
              step: 'build',
              name: '_adotInjectXrayContextMiddleware',
              override: true,
            }
          );

          this.middlewareStack?.add(
            (next: any, context: any) => async (middlewareArgs: any) => {
              const activeContext = otelContext.active();
              // Skip credential extraction if this is a nested call from another credential extraction
              // This prevents infinite recursion when credential providers make AWS API calls
              if (activeContext.getValue(SKIP_CREDENTIAL_CAPTURE_KEY)) {
                return await next(middlewareArgs);
              }
              const span = trace.getSpan(activeContext);

              if (span) {
                // suppressTracing prevents span generation for internal credential extraction calls
                // which are implementation details and not relevant to the application's telemetry
                const suppressedContext = suppressTracing(activeContext).setValue(SKIP_CREDENTIAL_CAPTURE_KEY, true);
                // Skip credential extraction if the context is not injectable
                if (suppressedContext.getValue(SKIP_CREDENTIAL_CAPTURE_KEY)) {
                  await otelContext.with(suppressedContext, async () => {
                    try {
                      const credsProvider = this.config.credentials;
                      if (credsProvider instanceof Function) {
                        const credentials = await credsProvider();
                        if (credentials?.accessKeyId) {
                          span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_AUTH_ACCOUNT_ACCESS_KEY, credentials.accessKeyId);
                        }
                      }
                      if (this.config.region instanceof Function) {
                        const region = await this.config.region();
                        if (region) {
                          span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_AUTH_REGION, region);
                        }
                      }
                    } catch (err) {
                      diag.debug('Failed to get auth account access key and region:', err);
                    }
                  });
                }
              }

              return await next(middlewareArgs);
            },
            {
              step: 'build',
              name: '_adotExtractSignerCredentials',
              override: true,
            }
          );
          this.__adotMiddlewarePatched = true;
        }

        command[V3_CLIENT_CONFIG_KEY] = this.config;
        return original.apply(this, [command, ...args]);
      };
    };
  }
}
