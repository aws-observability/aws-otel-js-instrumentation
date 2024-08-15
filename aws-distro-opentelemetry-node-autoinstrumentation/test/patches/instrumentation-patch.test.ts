// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, diag } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { AwsInstrumentation, NormalizedRequest } from '@opentelemetry/instrumentation-aws-sdk';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../src/aws-attribute-keys';
import { RequestMetadata, ServiceExtension } from '../../src/third-party/otel/aws/services/ServiceExtension';
import { applyInstrumentationPatches } from './../../src/patches/instrumentation-patch';

const _STREAM_NAME: string = 'streamName';
const _BUCKET_NAME: string = 'bucketName';
const _QUEUE_NAME: string = 'queueName';
const _QUEUE_URL: string = 'https://sqs.us-east-1.amazonaws.com/123412341234/queueName';

const UNPATCHED_INSTRUMENTATIONS: Instrumentation[] = getNodeAutoInstrumentations();

const PATCHED_INSTRUMENTATIONS: Instrumentation[] = getNodeAutoInstrumentations();
applyInstrumentationPatches(PATCHED_INSTRUMENTATIONS);

describe('InstrumentationPatchTest', () => {
  it('SanityTestUnpatchedAwsSdkInstrumentation', () => {
    const awsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(awsSdkInstrumentation);

    // Not from patching
    expect(services.has('SQS')).toBeTruthy();
    expect(services.has('SNS')).toBeTruthy();
    expect(services.has('DynamoDB')).toBeTruthy();
    expect(services.has('Lambda')).toBeTruthy();
    // From patching but shouldn't be applied
    expect(services.has('S3')).toBeFalsy();
    expect(services.has('Kinesis')).toBeFalsy();
    expect(services.get('SQS')._requestPreSpanHook).toBeFalsy();
    expect(services.get('SQS').requestPreSpanHook).toBeTruthy();
  });

  it('PatchesAwsSdkInstrumentation', () => {
    const instrumentations: Instrumentation[] = getNodeAutoInstrumentations();
    applyInstrumentationPatches(instrumentations);
    const awsSdkInstrumentation = extractAwsSdkInstrumentation(instrumentations);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const services: Map<string, any> = (awsSdkInstrumentation as AwsInstrumentation).servicesExtensions?.services;
    // Not from patching
    expect(services.has('SQS')).toBeTruthy();
    expect(services.has('SNS')).toBeTruthy();
    expect(services.has('DynamoDB')).toBeTruthy();
    expect(services.has('Lambda')).toBeTruthy();
    // From patching
    expect(services.has('S3')).toBeTruthy();
    expect(services.has('Kinesis')).toBeTruthy();
    expect(services.get('SQS')._requestPreSpanHook).toBeTruthy();
    expect(services.get('SQS').requestPreSpanHook).toBeTruthy();
    // Sanity check
    expect(services.has('InvalidService')).toBeFalsy();
  });

  it('S3 without patching', () => {
    const unpatchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(unpatchedAwsSdkInstrumentation);
    expect(() => doExtractS3Attributes(services)).toThrow();
  });

  it('Kinesis without patching', () => {
    const unpatchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(unpatchedAwsSdkInstrumentation);
    expect(() => doExtractKinesisAttributes(services)).toThrow();
  });

  it('SQS without patching', () => {
    const unpatchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(unpatchedAwsSdkInstrumentation);
    expect(() => doExtractSqsAttributes(services)).not.toThrow();

    let sqsAttributes: Attributes = doExtractSqsAttributes(services, false);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL]).toBeUndefined();
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME]).toBeUndefined();

    sqsAttributes = doExtractSqsAttributes(services, true);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL]).toBeUndefined();
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME]).toBeUndefined();
  });

  it('S3 with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const s3Attributes: Attributes = doExtractS3Attributes(services);
    expect(s3Attributes[AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET]).toEqual(_BUCKET_NAME);
  });

  it('Kinesis with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const kinesisAttributes: Attributes = doExtractKinesisAttributes(services);
    expect(kinesisAttributes[AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME]).toEqual(_STREAM_NAME);
  });

  it('SQS with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const sqsAttributes: Attributes = doExtractSqsAttributes(services, false);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL]).toEqual(_QUEUE_URL);
  });

  it('SQS with patching if Queue Name was available (but is not)', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const sqsAttributes: Attributes = doExtractSqsAttributes(services, true);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL]).toEqual(_QUEUE_URL);
  });

  function extractAwsSdkInstrumentation(instrumentations: Instrumentation[]): AwsInstrumentation {
    const filteredInstrumentations: Instrumentation[] = instrumentations.filter(
      instrumentation => instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-sdk'
    );
    expect(filteredInstrumentations.length).toEqual(1);
    return filteredInstrumentations[0] as AwsInstrumentation;
  }

  function extractServicesFromAwsSdkInstrumentation(awsSdkInstrumentation: AwsInstrumentation): Map<string, any> {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const services: Map<string, any> = (awsSdkInstrumentation as AwsInstrumentation).servicesExtensions?.services;
    if (services === undefined) {
      throw new Error('extractServicesFromAwsSdkInstrumentation() returned undefined `services`');
    }
    return services;
  }

  function doExtractKinesisAttributes(services: Map<string, ServiceExtension>): Attributes {
    const serviceName: string = 'Kinesis';
    const params: NormalizedRequest = {
      serviceName: serviceName,
      commandName: 'mockCommandName',
      commandInput: {
        StreamName: _STREAM_NAME,
      },
    };
    return doExtractAttributes(services, serviceName, params);
  }

  function doExtractS3Attributes(services: Map<string, ServiceExtension>): Attributes {
    const serviceName: string = 'S3';
    const params: NormalizedRequest = {
      serviceName: serviceName,
      commandName: 'mockCommandName',
      commandInput: {
        Bucket: _BUCKET_NAME,
      },
    };
    return doExtractAttributes(services, serviceName, params);
  }

  function doExtractSqsAttributes(
    services: Map<string, ServiceExtension>,
    includeQueueName: boolean = false
  ): Attributes {
    const serviceName: string = 'SQS';
    const params: NormalizedRequest = {
      serviceName: serviceName,
      commandName: 'mockCommandName',
      commandInput: {
        QueueUrl: _QUEUE_URL,
      },
    };
    if (includeQueueName) {
      params.commandInput.QueueName = _QUEUE_NAME;
    }
    return doExtractAttributes(services, serviceName, params);
  }

  function doExtractAttributes(
    services: Map<string, ServiceExtension>,
    serviceName: string,
    requestInput: NormalizedRequest
  ): Attributes {
    const serviceExtension: ServiceExtension | undefined = services.get(serviceName);
    if (serviceExtension === undefined) {
      throw new Error(`serviceExtension for ${serviceName} is not defined in the provided Map of services`);
    }
    const requestMetadata: RequestMetadata = serviceExtension.requestPreSpanHook(requestInput, {}, diag);
    return requestMetadata.spanAttributes || {};
  }
});
