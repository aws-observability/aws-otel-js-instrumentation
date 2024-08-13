// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue } from '@opentelemetry/api';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { AwsSdkInstrumentationConfig, NormalizedRequest } from '@opentelemetry/instrumentation-aws-sdk';
import { SEMATTRS_MESSAGING_URL } from '@opentelemetry/semantic-conventions';
import { AWS_ATTRIBUTE_KEYS } from '../aws-attribute-keys';
import { SqsUrlParser } from '../sqs-url-parser';
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
        const sqsServiceExtension: any = services.get('SQS');
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
              const queueUrl: AttributeValue | undefined = requestMetadata.spanAttributes[SEMATTRS_MESSAGING_URL];
              requestMetadata.spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL] = queueUrl;
              requestMetadata.spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME] =
                SqsUrlParser.getQueueName(queueUrl);
            }
            return requestMetadata;
          };
          sqsServiceExtension.requestPreSpanHook = patchedRequestPreSpanHook;
        }
      }
    }
  });
}
