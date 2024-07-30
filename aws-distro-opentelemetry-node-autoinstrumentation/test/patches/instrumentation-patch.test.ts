// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { expect } from 'expect';
import { applyInstrumentationPatches } from './../../src/patches/instrumentation-patch';

describe('InstrumentationPatchTest', () => {
  it('PatchAwsSdkInstrumentation', () => {
    const instrumentations: Instrumentation[] = getNodeAutoInstrumentations();
    applyInstrumentationPatches(instrumentations);

    const filteredInstrumentations: Instrumentation[] = instrumentations.filter(
      instrumentation => instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-sdk'
    );
    expect(filteredInstrumentations.length).toEqual(1);

    const awsSdkInstrumentation = filteredInstrumentations[0];
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const services: Map<string, ServiceExtension> = (awsSdkInstrumentation as AwsInstrumentation).servicesExtensions
      ?.services;
    // Not from patching
    expect(services.has('SQS')).toBeTruthy();
    expect(services.has('SNS')).toBeTruthy();
    expect(services.has('DynamoDB')).toBeTruthy();
    expect(services.has('Lambda')).toBeTruthy();
    // From patching
    expect(services.has('S3')).toBeTruthy();
    expect(services.has('Kinesis')).toBeTruthy();
    // Sanity check
    expect(services.has('InvalidService')).toBeFalsy();
  });
});
