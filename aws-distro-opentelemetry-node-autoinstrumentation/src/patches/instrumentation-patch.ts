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
} from '@opentelemetry/api';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { AwsSdkInstrumentationConfig, NormalizedRequest } from '@opentelemetry/instrumentation-aws-sdk';
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
import { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node';
import { AwsSdkInstrumentationExtended } from './extended-instrumentations/aws-sdk-instrumentation-extended';
import { AwsLambdaInstrumentationPatch } from './extended-instrumentations/aws-lambda';

export const traceContextEnvironmentKey = '_X_AMZN_TRACE_ID';
const awsPropagator = new AWSXRayPropagator();
export const headerGetter: TextMapGetter<APIGatewayProxyEventHeaders> = {
  keys(carrier: any): string[] {
    return Object.keys(carrier);
  },
  get(carrier: any, key: string) {
    return carrier[key];
  },
};

export function applyInstrumentationPatches(
  instrumentations: Instrumentation[],
  instrumentationConfigs?: InstrumentationConfigMap
): void {
  /*
  Apply patches to upstream instrumentation libraries.

  This method is invoked to apply changes to upstream instrumentation libraries, typically when changes to upstream
  are required on a timeline that cannot wait for upstream release. Generally speaking, patches should be short-term
  local solutions that are comparable to long-term upstream solutions.

  Where possible, automated testing should be run to catch upstream changes resulting in broken patches
  */
  instrumentations.forEach((instrumentation, index) => {
    if (instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-sdk') {
      diag.debug('Overriding aws sdk instrumentation');
      instrumentations[index] = new AwsSdkInstrumentationExtended(
        instrumentationConfigs ? instrumentationConfigs['@opentelemetry/instrumentation-aws-sdk'] : undefined
      );

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
      }
    } else if (instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-lambda') {
      diag.debug('Overriding aws lambda instrumentation');
      const lambdaInstrumentation = new AwsLambdaInstrumentationPatch({
        eventContextExtractor: customExtractor,
      });
      instrumentations[index] = lambdaInstrumentation;
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
      }
      return requestMetadata;
    };

    lambdaServiceExtension.requestPreSpanHook = patchedRequestPreSpanHook;
  }
}
