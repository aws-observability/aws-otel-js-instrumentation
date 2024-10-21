// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, SpanContext, SpanKind } from '@opentelemetry/api';
import { InstrumentationLibrary } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  MESSAGINGOPERATIONVALUES_PROCESS,
  MESSAGINGOPERATIONVALUES_RECEIVE,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_TARGET,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_RPC_SYSTEM,
} from '@opentelemetry/semantic-conventions';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../src/aws-attribute-keys';
import { AwsSpanProcessingUtil } from '../src/aws-span-processing-util';

const DEFAULT_PATH_VALUE: string = '/';
const UNKNOWN_OPERATION: string = 'UnknownOperation';
const INTERNAL_OPERATION: string = 'InternalOperation';

let attributesMock: Attributes;
let spanDataMock: ReadableSpan;

describe('AwsSpanProcessingUtilTest', () => {
  beforeEach(() => {
    attributesMock = {};
    spanDataMock = {
      name: 'spanName',
      kind: SpanKind.SERVER,
      spanContext: () => {
        const spanContext: SpanContext = {
          traceId: '00000000000000000000000000000008',
          spanId: '0000000000000009',
          traceFlags: 0,
        };
        return spanContext;
      },
      startTime: [0, 0],
      endTime: [0, 1],
      status: { code: 0 },
      attributes: {},
      links: [],
      events: [],
      duration: [0, 1],
      ended: true,
      resource: new Resource({}),
      instrumentationLibrary: { name: 'mockedLibrary' },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    (spanDataMock as any).attributes = attributesMock;
  });

  it('testGetIngressOperationValidName', () => {
    const validName: string = 'ValidName';
    (spanDataMock as any).name = validName;
    (spanDataMock as any).kind = SpanKind.SERVER;
    const actualOperation: string = AwsSpanProcessingUtil.getIngressOperation(spanDataMock);
    expect(actualOperation).toEqual(validName);
  });

  it('testGetIngressOperationWithNotServer', () => {
    const validName: string = 'ValidName';
    (spanDataMock as any).name = validName;
    (spanDataMock as any).kind = SpanKind.CLIENT;
    const actualOperation: string = AwsSpanProcessingUtil.getIngressOperation(spanDataMock);
    expect(actualOperation).toEqual(INTERNAL_OPERATION);
  });

  it('testGetIngressOperationHttpMethodNameAndNoFallback', () => {
    const invalidName: string = 'GET';
    (spanDataMock as any).name = invalidName;
    (spanDataMock as any).kind = SpanKind.SERVER;
    attributesMock[SEMATTRS_HTTP_METHOD] = invalidName;
    const actualOperation: string = AwsSpanProcessingUtil.getIngressOperation(spanDataMock);
    expect(actualOperation).toEqual(UNKNOWN_OPERATION);
  });

  it('testGetIngressOperationNullNameAndNoFallback', () => {
    const invalidName: string | null = null;
    (spanDataMock as any).name = invalidName;
    (spanDataMock as any).kind = SpanKind.SERVER;
    const actualOperation: string = AwsSpanProcessingUtil.getIngressOperation(spanDataMock);
    expect(actualOperation).toEqual(UNKNOWN_OPERATION);
  });

  it('testGetIngressOperationUnknownNameAndNoFallback', () => {
    const invalidName: string = UNKNOWN_OPERATION;
    (spanDataMock as any).name = invalidName;
    (spanDataMock as any).kind = SpanKind.SERVER;
    const actualOperation: string = AwsSpanProcessingUtil.getIngressOperation(spanDataMock);
    expect(actualOperation).toEqual(UNKNOWN_OPERATION);
  });

  it('testGetIngressOperationInvalidNameAndValidTarget', () => {
    const invalidName: string | null = null;
    const validTarget: string = '/';
    (spanDataMock as any).name = invalidName;
    (spanDataMock as any).kind = SpanKind.SERVER;
    attributesMock[SEMATTRS_HTTP_TARGET] = validTarget;
    const actualOperation: string = AwsSpanProcessingUtil.getIngressOperation(spanDataMock);
    expect(actualOperation).toEqual(validTarget);
  });

  it('testGetIngressOperationInvalidNameAndValidTargetAndMethod', () => {
    const invalidName: string | null = null;
    const validTarget: string = '/';
    const validMethod: string = 'GET';
    (spanDataMock as any).name = invalidName;
    (spanDataMock as any).kind = SpanKind.SERVER;
    attributesMock[SEMATTRS_HTTP_TARGET] = validTarget;
    attributesMock[SEMATTRS_HTTP_METHOD] = validMethod;
    const actualOperation: string = AwsSpanProcessingUtil.getIngressOperation(spanDataMock);
    expect(actualOperation).toEqual(validMethod + ' ' + validTarget);
  });

  it('testGetEgressOperationUseInternalOperation', () => {
    const invalidName: string | null = null;
    (spanDataMock as any).name = invalidName;
    (spanDataMock as any).kind = SpanKind.CONSUMER;
    const actualOperation: string | undefined = AwsSpanProcessingUtil.getEgressOperation(spanDataMock);
    expect(actualOperation).toEqual(INTERNAL_OPERATION);
  });

  it('testGetEgressOperationGetLocalOperation', () => {
    const operation: string = 'TestOperation';
    attributesMock[AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION] = operation;
    (spanDataMock as any).attributes = attributesMock;
    (spanDataMock as any).kind = SpanKind.SERVER;
    const actualOperation: string | undefined = AwsSpanProcessingUtil.getEgressOperation(spanDataMock);
    expect(actualOperation).toEqual(operation);
  });

  it('testExtractAPIPathValueEmptyTarget', () => {
    const invalidTarget: string = '';
    const pathValue: string = AwsSpanProcessingUtil.extractAPIPathValue(invalidTarget);
    expect(pathValue).toEqual(DEFAULT_PATH_VALUE);
  });

  it('testExtractAPIPathValueNullTarget', () => {
    const invalidTarget: string | undefined = undefined;
    const pathValue: string = AwsSpanProcessingUtil.extractAPIPathValue(invalidTarget);
    expect(pathValue).toEqual(DEFAULT_PATH_VALUE);
  });

  it('testExtractAPIPathValueNoSlash', () => {
    const invalidTarget: string = 'users';
    const pathValue: string = AwsSpanProcessingUtil.extractAPIPathValue(invalidTarget);
    expect(pathValue).toEqual(DEFAULT_PATH_VALUE);
  });

  it('testExtractAPIPathValueOnlySlash', () => {
    const invalidTarget: string = '/';
    const pathValue: string = AwsSpanProcessingUtil.extractAPIPathValue(invalidTarget);
    expect(pathValue).toEqual(DEFAULT_PATH_VALUE);
  });

  it('testExtractAPIPathValueOnlySlashAtEnd', () => {
    const invalidTarget: string = 'users/';
    const pathValue: string = AwsSpanProcessingUtil.extractAPIPathValue(invalidTarget);
    expect(pathValue).toEqual(DEFAULT_PATH_VALUE);
  });

  it('testExtractAPIPathValidPath', () => {
    const validTarget: string = '/users/1/pet?query#fragment';
    const pathValue: string = AwsSpanProcessingUtil.extractAPIPathValue(validTarget);
    expect(pathValue).toEqual('/users');
  });

  it('testExtractAPIPathValidPathSingleSlash', () => {
    let validTarget: string = '/users?query#fragment';
    let pathValue: string = AwsSpanProcessingUtil.extractAPIPathValue(validTarget);
    expect(pathValue).toEqual('/users');

    validTarget = '/users#fragment?fragment_part_2';
    pathValue = AwsSpanProcessingUtil.extractAPIPathValue(validTarget);
    expect(pathValue).toEqual('/users');

    validTarget = '/users?query';
    pathValue = AwsSpanProcessingUtil.extractAPIPathValue(validTarget);
    expect(pathValue).toEqual('/users');

    validTarget = '/users#fragment';
    pathValue = AwsSpanProcessingUtil.extractAPIPathValue(validTarget);
    expect(pathValue).toEqual('/users');
  });

  it('testIsKeyPresentKeyPresent', () => {
    attributesMock[SEMATTRS_HTTP_TARGET] = 'target';
    expect(AwsSpanProcessingUtil.isKeyPresent(spanDataMock, SEMATTRS_HTTP_TARGET)).toBeTruthy();
  });

  it('testIsKeyPresentKeyAbsent', () => {
    expect(AwsSpanProcessingUtil.isKeyPresent(spanDataMock, SEMATTRS_HTTP_TARGET)).toBeFalsy();
  });

  it('testIsAwsSpanTrue', () => {
    attributesMock[SEMATTRS_RPC_SYSTEM] = 'aws-api';
    expect(AwsSpanProcessingUtil.isAwsSDKSpan(spanDataMock)).toBeTruthy();
  });

  it('testIsAwsSpanFalse', () => {
    expect(AwsSpanProcessingUtil.isAwsSDKSpan(spanDataMock)).toBeFalsy();
  });

  it('testShouldUseInternalOperationFalse', () => {
    (spanDataMock as any).kind = SpanKind.SERVER;
    expect(AwsSpanProcessingUtil.shouldUseInternalOperation(spanDataMock)).toBeFalsy();

    const parentSpanContext: SpanContext = createMockSpanContext();
    (parentSpanContext as any).isRemote = false;

    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as false because parentSpanContext is valid and not remote
    spanDataMock.attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = false;
    (spanDataMock as any).kind = SpanKind.CONSUMER;

    expect(AwsSpanProcessingUtil.shouldUseInternalOperation(spanDataMock)).toBeFalsy();
  });

  it('testShouldGenerateServiceMetricAttributes', () => {
    const parentSpanContext: SpanContext = {
      traceId: '00000000000000000000000000000008',
      spanId: '0000000000000009',
      traceFlags: 0,
    };
    (parentSpanContext as any).isRemote = false;

    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as false because parentSpanContext is valid and not remote
    spanDataMock.attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = false;

    (spanDataMock as any).kind = SpanKind.SERVER;
    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeTruthy();

    (spanDataMock as any).kind = SpanKind.CONSUMER;
    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeFalsy();

    (spanDataMock as any).kind = SpanKind.INTERNAL;
    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeFalsy();

    (spanDataMock as any).kind = SpanKind.PRODUCER;
    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeFalsy();

    (spanDataMock as any).kind = SpanKind.CLIENT;
    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeFalsy();

    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as true because parentSpanContext is remote
    spanDataMock.attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = true;
    (spanDataMock as any).kind = SpanKind.PRODUCER;
    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeTruthy();
  });

  it('testShouldGenerateDependencyMetricAttributes', () => {
    (spanDataMock as any).kind = SpanKind.SERVER;
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeFalsy();

    (spanDataMock as any).kind = SpanKind.INTERNAL;
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeFalsy();

    (spanDataMock as any).kind = SpanKind.CONSUMER;
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeTruthy();

    (spanDataMock as any).kind = SpanKind.PRODUCER;
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeTruthy();

    (spanDataMock as any).kind = SpanKind.CLIENT;
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeTruthy();

    const parentSpanContextMock: SpanContext = createMockSpanContext();
    (parentSpanContextMock as any).isRemote = false;
    (spanDataMock as any).kind = SpanKind.CONSUMER;
    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as false because isRemote is false
    spanDataMock.attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = false;

    attributesMock[SEMATTRS_MESSAGING_OPERATION] = MESSAGINGOPERATIONVALUES_PROCESS;
    attributesMock[AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND] = SpanKind[SpanKind.CONSUMER];
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeFalsy();

    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as true because parentSpanContextMock is not valid
    spanDataMock.attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = true;
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeTruthy();
  });

  // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT to test isLocalRoot
  it('testIsLocalRoot', () => {
    // AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT is undefined
    expect(AwsSpanProcessingUtil.isLocalRoot(spanDataMock)).toBeTruthy();

    spanDataMock.attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = true;
    expect(AwsSpanProcessingUtil.isLocalRoot(spanDataMock)).toBeTruthy();

    spanDataMock.attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = false;
    expect(AwsSpanProcessingUtil.isLocalRoot(spanDataMock)).toBeFalsy();
  });

  it('testIsConsumerProcessSpanFalse', () => {
    expect(AwsSpanProcessingUtil.isConsumerProcessSpan(spanDataMock)).toBeFalsy();
  });

  it('testIsConsumerProcessSpanTrue', () => {
    attributesMock[SEMATTRS_MESSAGING_OPERATION] = MESSAGINGOPERATIONVALUES_PROCESS;
    (spanDataMock as any).kind = SpanKind.CONSUMER;
    expect(AwsSpanProcessingUtil.isConsumerProcessSpan(spanDataMock)).toBeTruthy();
  });

  // check that AWS SDK SQS ReceiveMessage consumer spans metrics are suppressed
  it('testNoMetricAttributesForSqsConsumerSpanAwsSdk', () => {
    const instrumentationLibrary: InstrumentationLibrary = {
      name: '@opentelemetry/instrumentation-aws-sdk',
    };
    (spanDataMock as any).instrumentationLibrary = instrumentationLibrary;
    (spanDataMock as any).kind = SpanKind.CONSUMER;
    (spanDataMock as any).name = 'SQS.ReceiveMessage';

    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeFalsy();
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeFalsy();
  });

  // check that SQS ReceiveMessage consumer spans metrics are still generated for other
  // instrumentation
  it('testMetricAttributesGeneratedForOtherInstrumentationSqsConsumerSpan', () => {
    const instrumentationLibrary: InstrumentationLibrary = {
      name: 'my-instrumentationy',
    };
    (spanDataMock as any).instrumentationLibrary = instrumentationLibrary;
    (spanDataMock as any).kind = SpanKind.CONSUMER;
    (spanDataMock as any).name = 'Sqs.ReceiveMessage';

    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeTruthy();
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeTruthy();
  });

  // check that SQS ReceiveMessage consumer span metrics are suppressed if messaging operation is
  // process and not receive
  it('testNoMetricAttributesForAwsSdkSqsConsumerProcessSpan', () => {
    const instrumentationLibrary: InstrumentationLibrary = {
      name: '@opentelemetry/instrumentation-aws-sdk',
    };
    (spanDataMock as any).instrumentationLibrary = instrumentationLibrary;
    (spanDataMock as any).kind = SpanKind.CONSUMER;
    (spanDataMock as any).name = 'Sqs.ReceiveMessage';
    attributesMock[SEMATTRS_MESSAGING_OPERATION] = MESSAGINGOPERATIONVALUES_PROCESS;

    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeFalsy();
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeFalsy();

    attributesMock[SEMATTRS_MESSAGING_OPERATION] = MESSAGINGOPERATIONVALUES_RECEIVE;
    expect(AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)).toBeTruthy();
    expect(AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)).toBeTruthy();
  });

  it('testSqlDialectKeywordsOrder', () => {
    const keywords: string[] = AwsSpanProcessingUtil.getDialectKeywords();
    let prevKeywordLength: number = Number.MAX_VALUE;
    keywords.forEach((keyword: string) => {
      const currKeywordLength: number = keyword.length;
      expect(prevKeywordLength >= currKeywordLength);
      prevKeywordLength = currKeywordLength;
    });
  });

  it('testSqlDialectKeywordsMaxLength', () => {
    const keywords: string[] = AwsSpanProcessingUtil.getDialectKeywords();
    keywords.forEach((keyword: string) => {
      expect(AwsSpanProcessingUtil.MAX_KEYWORD_LENGTH).toBeGreaterThanOrEqual(keyword.length);
    });
  });

  it('testGetIngressOperationForLambda', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'TestFunction';
    const validName: string = 'ValidName';
    (spanDataMock as any).name = validName;
    (spanDataMock as any).kind = SpanKind.SERVER;
    const actualOperation: string = AwsSpanProcessingUtil.getIngressOperation(spanDataMock);
    expect(actualOperation).toEqual('TestFunction/FunctionHandler');
  });

  it('should return cloud.resource_id when present', () => {
    spanDataMock.attributes[AwsSpanProcessingUtil.CLOUD_RESOURCE_ID] = 'cloud-123';
    const result = AwsSpanProcessingUtil.getResourceId(spanDataMock);
    expect(result).toBe('cloud-123');
  });

  it('should return faas.id when cloud.resource_id is not present', () => {
    spanDataMock.attributes['faas.id'] = 'faas-123';
    const result = AwsSpanProcessingUtil.getResourceId(spanDataMock);
    expect(result).toBe('faas-123');
  });

  it('should return cloud.resource_id when both cloud.resource_id and faas.id are present', () => {
    spanDataMock.attributes[AwsSpanProcessingUtil.CLOUD_RESOURCE_ID] = 'cloud-123';
    spanDataMock.attributes['faas.id'] = 'faas-123';
    const result = AwsSpanProcessingUtil.getResourceId(spanDataMock);
    expect(result).toBe('cloud-123');
  });

  it('should return undefined when neither cloud.resource_id nor faas.id are present', () => {
    const result = AwsSpanProcessingUtil.getResourceId(spanDataMock);
    expect(result).toBeUndefined();
  });

  it('should return undefined if cloud.resource_id is not a string', () => {
    spanDataMock.attributes[AwsSpanProcessingUtil.CLOUD_RESOURCE_ID] = 123; // Incorrect type
    const result = AwsSpanProcessingUtil.getResourceId(spanDataMock);
    expect(result).toBeUndefined();
  });
});

function createMockSpanContext(): SpanContext {
  return {
    traceId: '00000000000000000000000000000008',
    spanId: '0000000000000009',
    traceFlags: 0,
  };
}
