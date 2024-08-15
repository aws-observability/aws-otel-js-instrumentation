// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Instrumentation } from '@opentelemetry/instrumentation';
import { AwsSdkInstrumentationConfig, NormalizedRequest } from '@opentelemetry/instrumentation-aws-sdk';
import { AWS_ATTRIBUTE_KEYS } from '../aws-attribute-keys';
import { RequestMetadata } from '../third-party/otel/aws/services/ServiceExtension';
import { KinesisServiceExtension } from './aws/services/kinesis';
import { S3ServiceExtension } from './aws/services/s3';

export function applyInstrumentationPatches(instrumentations: Instrumentation[]): void {
  /*
  Apply patches to upstream instrumentation libraries.

  This method is invoked to apply changes to upstream instrumentation libraries, typically when changes to upstream
  are required on a timeline that cannot wait for upstream release. Generally speaking, patches should be short-term
  local solutions that are comparable to long-term upstream solutions.

  Where possible, automated testing should be run to catch upstream changes resulting in broken patches
  */
  instrumentations.forEach(instrumentation => {
    if (instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-sdk') {
      // Access private property servicesExtensions of AwsInstrumentation
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const services: Map<string, ServiceExtension> | undefined = (instrumentation as any).servicesExtensions?.services;
      if (services) {
        services.set('S3', new S3ServiceExtension());
        services.set('Kinesis', new KinesisServiceExtension());
        patchSqsServiceExtension(services.get('SQS'));
      }
    }
  });
}

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
