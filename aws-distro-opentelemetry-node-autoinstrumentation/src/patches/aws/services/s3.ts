// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, Span, SpanKind, Tracer } from '@opentelemetry/api';
import {
  AwsSdkInstrumentationConfig,
  NormalizedRequest,
  NormalizedResponse,
} from '@opentelemetry/instrumentation-aws-sdk';
import { RequestMetadata, ServiceExtension } from './ServiceExtension';

// The OpenTelemetry Authors code
// This file's contents are being contributed to upstream
// - https://github.com/open-telemetry/opentelemetry-js-contrib/pull/2361

const _AWS_S3_BUCKET = 'aws.s3.bucket';

export class S3ServiceExtension implements ServiceExtension {
  requestPreSpanHook(request: NormalizedRequest, _config: AwsSdkInstrumentationConfig): RequestMetadata {
    const bucketName = request.commandInput.Bucket;

    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;

    const spanAttributes: Attributes = {};

    if (bucketName) {
      spanAttributes[_AWS_S3_BUCKET] = bucketName;
    }

    const isIncoming = false;

    return {
      isIncoming,
      spanAttributes,
      spanKind,
      spanName,
    };
  }

  requestPostSpanHook = (request: NormalizedRequest) => {};

  responseHook = (response: NormalizedResponse, span: Span, tracer: Tracer, config: AwsSdkInstrumentationConfig) => {};
}
