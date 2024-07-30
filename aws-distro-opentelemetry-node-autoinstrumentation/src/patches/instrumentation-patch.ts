// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Instrumentation } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { KinesisServiceExtension, S3ServiceExtension } from './aws/services';

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
      const services = (instrumentation as AwsInstrumentation).servicesExtensions?.services;
      if (services) {
        services.set('S3', new S3ServiceExtension());
        services.set('Kinesis', new KinesisServiceExtension());
      }
    }
  });
}
