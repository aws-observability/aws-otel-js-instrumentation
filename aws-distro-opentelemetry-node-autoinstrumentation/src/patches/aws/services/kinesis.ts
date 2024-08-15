// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, SpanKind } from '@opentelemetry/api';
import { AwsSdkInstrumentationConfig, NormalizedRequest } from '@opentelemetry/instrumentation-aws-sdk';
import { AWS_ATTRIBUTE_KEYS } from '../../../aws-attribute-keys';
import { RequestMetadata, ServiceExtension } from '../../../third-party/otel/aws/services/ServiceExtension';

/*
This file's contents are being contributed to upstream
- https://github.com/open-telemetry/opentelemetry-js-contrib/pull/2361

This class is a service extension to be used for the AWS JavaScript SDK instrumentation patch for Kinesis.
The instrumentation patch adds this extension to the upstream's Map of known extension for Kinesis.
Extensions allow for custom logic for adding service-specific information to spans, such as attributes.
Specifically, we are adding logic to add the `aws.kinesis.stream.name` attribute, to be used to generate
RemoteTarget and achieve parity with the Java/Python instrumentation.
*/
export class KinesisServiceExtension implements ServiceExtension {
  requestPreSpanHook(request: NormalizedRequest, _config: AwsSdkInstrumentationConfig): RequestMetadata {
    const streamName = request.commandInput?.StreamName;

    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;

    const spanAttributes: Attributes = {};

    if (streamName) {
      spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME] = streamName;
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
