// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, SpanKind } from '@opentelemetry/api';
import { AwsSdkInstrumentationConfig, NormalizedRequest } from '@opentelemetry/instrumentation-aws-sdk';
import { AWS_ATTRIBUTE_KEYS } from '../../../aws-attribute-keys';
import { RequestMetadata, ServiceExtension } from '../../../third-party/otel/aws/services/ServiceExtension';

/*
This file's contents are being contributed to upstream
- https://github.com/open-telemetry/opentelemetry-js-contrib/pull/2361

This class is a service extension to be used for the AWS JavaScript SDK instrumentation patch for S3.
The instrumentation patch adds this extension to the upstream's Map of known extension for S3.
Extensions allow for custom logic for adding service-specific information to spans, such as attributes.
Specifically, we are adding logic to add the `aws.s3.bucket` attribute, to be used to generate
RemoteTarget and achieve parity with the Java/Python instrumentation.
*/
export class S3ServiceExtension implements ServiceExtension {
  requestPreSpanHook(request: NormalizedRequest, _config: AwsSdkInstrumentationConfig): RequestMetadata {
    const bucketName = request.commandInput?.Bucket;

    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;

    const spanAttributes: Attributes = {};

    if (bucketName) {
      spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET] = bucketName;
    }

    const isIncoming = false;

    return {
      isIncoming,
      spanAttributes,
      spanKind,
      spanName,
    };
  }
}
