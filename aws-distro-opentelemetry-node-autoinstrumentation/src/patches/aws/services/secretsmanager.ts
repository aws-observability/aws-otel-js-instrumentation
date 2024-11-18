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

export class SecretsManagerServiceExtension implements ServiceExtension {
  requestPreSpanHook(request: NormalizedRequest, _config: AwsSdkInstrumentationConfig): RequestMetadata {
    const secretId = request.commandInput?.SecretId;

    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;

    const spanAttributes: Attributes = {};

    if (secretId && secretId.startsWith('arn:aws:secretsmanager:')) {
      spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN] = secretId;
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
    const secret_arn = response.data.ARN;

    if (secret_arn) {
      span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN, secret_arn);
    }
  }
}
