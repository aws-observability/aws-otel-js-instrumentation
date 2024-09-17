// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, diag, Context as OtelContext, trace, propagation, Span } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { AwsInstrumentation, NormalizedRequest } from '@opentelemetry/instrumentation-aws-sdk';
import { AwsLambdaInstrumentation, AwsLambdaInstrumentationConfig } from '@opentelemetry/instrumentation-aws-lambda';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../src/aws-attribute-keys';
import { RequestMetadata, ServiceExtension } from '../../src/third-party/otel/aws/services/ServiceExtension';
import { applyInstrumentationPatches, customExtractor } from './../../src/patches/instrumentation-patch';
import * as sinon from 'sinon';
import { AWSXRAY_TRACE_ID_HEADER, AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { Context } from 'aws-lambda';
import { SinonStub } from 'sinon';

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
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME]).toBeUndefined();
  });

  it('SQS with patching if Queue Name was available (but is not)', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const sqsAttributes: Attributes = doExtractSqsAttributes(services, true);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL]).toEqual(_QUEUE_URL);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME]).toEqual(_QUEUE_NAME);
  });

  it('Lambda with custom eventContextExtractor patching', () => {
    const patchedAwsSdkInstrumentation: AwsLambdaInstrumentation =
      extractLambdaInstrumentation(PATCHED_INSTRUMENTATIONS);
    expect(
      (patchedAwsSdkInstrumentation.getConfig() as AwsLambdaInstrumentationConfig).eventContextExtractor
    ).not.toBeUndefined();
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

  function extractLambdaInstrumentation(instrumentations: Instrumentation[]): AwsLambdaInstrumentation {
    const filteredInstrumentations: Instrumentation[] = instrumentations.filter(
      instrumentation => instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-lambda'
    );
    expect(filteredInstrumentations.length).toEqual(1);
    return filteredInstrumentations[0] as AwsLambdaInstrumentation;
  }
});

describe('customExtractor', () => {
  const traceContextEnvironmentKey = '_X_AMZN_TRACE_ID';
  const MOCK_XRAY_TRACE_ID = '8a3c60f7d188f8fa79d48a391a778fa6';
  const MOCK_XRAY_TRACE_ID_STR = '1-8a3c60f7-d188f8fa79d48a391a778fa6';
  const MOCK_XRAY_PARENT_SPAN_ID = '53995c3f42cd8ad8';
  const MOCK_XRAY_LAMBDA_LINEAGE = 'Lineage=01cfa446:0';

  const TRACE_ID_VERSION = '1'; // Assuming TRACE_ID_VERSION is defined somewhere in the code

  // Common part of the XRAY trace context
  const MOCK_XRAY_TRACE_CONTEXT_COMMON = `Root=${TRACE_ID_VERSION}-${MOCK_XRAY_TRACE_ID_STR};Parent=${MOCK_XRAY_PARENT_SPAN_ID}`;

  // Different versions of the XRAY trace context
  const MOCK_XRAY_TRACE_CONTEXT_SAMPLED = `${MOCK_XRAY_TRACE_CONTEXT_COMMON};Sampled=1;${MOCK_XRAY_LAMBDA_LINEAGE}`;
  //   const MOCK_XRAY_TRACE_CONTEXT_PASSTHROUGH = (
  //     `Root=${TRACE_ID_VERSION}-${MOCK_XRAY_TRACE_ID_STR.slice(0, TRACE_ID_FIRST_PART_LENGTH)}` +
  //     `-${MOCK_XRAY_TRACE_ID_STR.slice(TRACE_ID_FIRST_PART_LENGTH)};${MOCK_XRAY_LAMBDA_LINEAGE}`
  //   );

  // Create the W3C Trace Context (Sampled)
  const MOCK_W3C_TRACE_CONTEXT_SAMPLED = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  // // W3C Trace State
  const MOCK_W3C_TRACE_STATE_KEY = 'vendor_specific_key';
  const MOCK_W3C_TRACE_STATE_VALUE = 'test_value';
  const MOCK_TRACE_STATE = `${MOCK_W3C_TRACE_STATE_KEY}=${MOCK_W3C_TRACE_STATE_VALUE},foo=1,bar=2`;

  let awsPropagatorStub: SinonStub;
  let traceGetSpanStub: SinonStub;
  // let propagationStub: SinonStub;

  beforeEach(() => {
    // Clear environment variables before each test
    delete process.env[traceContextEnvironmentKey];
  });

  afterEach(() => {
    // Restore original methods after each test to ensure stubs don't affect other tests
    sinon.restore();
  });

  it('should extract context from lambda trace header when present', () => {
    const mockLambdaTraceHeader = MOCK_XRAY_TRACE_CONTEXT_SAMPLED;
    process.env[traceContextEnvironmentKey] = mockLambdaTraceHeader;

    const mockParentContext = {} as OtelContext;

    // Partial mock of the Span object
    const mockSpan: Partial<Span> = {
      spanContext: sinon.stub().returns({
        traceId: MOCK_XRAY_TRACE_ID,
        spanId: MOCK_XRAY_PARENT_SPAN_ID,
      }),
    };

    // Stub awsPropagator.extract to return the mockParentContext
    awsPropagatorStub = sinon.stub(AWSXRayPropagator.prototype, 'extract').returns(mockParentContext);

    // Stub trace.getSpan to return the mock span
    traceGetSpanStub = sinon.stub(trace, 'getSpan').returns(mockSpan as Span);

    // Call the customExtractor function
    const event = { headers: {} };
    const result = customExtractor(event, {} as Context);

    // Assertions
    expect(awsPropagatorStub.calledOnce).toBe(true);
    expect(
      awsPropagatorStub.calledWith(
        sinon.match.any,
        { [AWSXRAY_TRACE_ID_HEADER]: mockLambdaTraceHeader },
        sinon.match.any
      )
    ).toBe(true);
    expect(traceGetSpanStub.calledOnce).toBe(true);
    expect(result).toEqual(mockParentContext); // Should return the parent context when valid
  });

  it('should extract context from HTTP headers when lambda trace header is not present', () => {
    delete process.env[traceContextEnvironmentKey];
    const event = {
      headers: {
        traceparent: MOCK_W3C_TRACE_CONTEXT_SAMPLED,
        tracestate: MOCK_TRACE_STATE,
      },
    };
    const mockExtractedContext = {
      getValue: function () {
        return undefined;
      }, // Empty function that returns undefined
    } as unknown as OtelContext;

    const propagationStub = sinon.stub(propagation, 'extract').returns(mockExtractedContext);

    // Call the customExtractor function
    const mockHttpHeaders = event.headers;
    customExtractor(event, {} as Context);

    expect(propagationStub.calledWith(sinon.match.any, mockHttpHeaders, sinon.match.any)).toBe(true);
  });
});
