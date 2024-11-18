// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, Span, SpanKind, Tracer } from '@opentelemetry/api';
import {
  AwsSdkInstrumentationConfig,
  NormalizedRequest,
  NormalizedResponse,
} from '@opentelemetry/instrumentation-aws-sdk';
import { AWS_ATTRIBUTE_KEYS } from '../../../aws-attribute-keys';
import { RequestMetadata, ServiceExtension } from '../../../third-party/otel/aws/services/ServiceExtension';

export class LambdaServiceExtension implements ServiceExtension {
  requestPreSpanHook(request: NormalizedRequest, _config: AwsSdkInstrumentationConfig): RequestMetadata {
    const requestFunctionName = request.commandInput?.FunctionName;
    const resourceMappingId = request.commandInput?.UUID;

    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;

    const spanAttributes: Attributes = {};

    let functionName = requestFunctionName;

    if (requestFunctionName) {
      if (requestFunctionName.startsWith('arn:aws:lambda:')) {
        const split = requestFunctionName.split(':');
        functionName = split[split.length - 1];
      }

      spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME] = functionName;
    }

    if (resourceMappingId) {
      spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_RESOURCE_MAPPING_ID] = resourceMappingId;
    }

    const isIncoming = false;

    return {
      isIncoming,
      spanAttributes,
      spanKind,
      spanName,
    };
  }

  responseHook(response: NormalizedResponse, span: Span, tracer: Tracer, config: AwsSdkInstrumentationConfig): void {
    if (response.data.Configuration) {
      const functionArn = response.data.Configuration.FunctionArn;

      if (functionArn) {
        span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_ARN, functionArn);
      }
    }
  }
}
