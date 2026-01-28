// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Span as APISpan,
  AttributeValue,
  Exception,
  Link,
  SpanAttributes,
  SpanContext,
  SpanKind,
  SpanStatus,
  TimeInput,
  TraceFlags,
  context,
  createTraceState,
  trace,
} from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { Tracer } from '@opentelemetry/api';
import {
  MESSAGINGOPERATIONVALUES_PROCESS,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_RPC_SYSTEM,
} from '@opentelemetry/semantic-conventions';
import expect from 'expect';
import { AttributePropagatingSpanProcessor } from '../src/attribute-propagating-span-processor';
import { AWS_ATTRIBUTE_KEYS } from '../src/aws-attribute-keys';
import { AwsSpanProcessingUtil } from '../src/aws-span-processing-util';

let tracer: Tracer;

const spanNameExtractor: (span: ReadableSpan) => string = AwsSpanProcessingUtil.getIngressOperation;
const spanNameKey: string = 'spanName';
const testKey1: string = 'key1';
const testKey2: string = 'key2';

const SPAN_KINDS: SpanKind[] = [
  SpanKind.INTERNAL,
  SpanKind.SERVER,
  SpanKind.CLIENT,
  SpanKind.PRODUCER,
  SpanKind.CONSUMER,
];

describe('AttributePropagatingSpanProcessorTest', () => {
  beforeEach(() => {
    const tracerProvider: NodeTracerProvider = new NodeTracerProvider({
      spanProcessors: [AttributePropagatingSpanProcessor.create(spanNameExtractor, spanNameKey, [testKey1, testKey2])],
    });
    tracer = tracerProvider.getTracer('awsxray');
  });

  it('testAttributesPropagationBySpanKind', () => {
    SPAN_KINDS.forEach((value: SpanKind) => {
      const spanWithAppOnly: APISpan = tracer.startSpan('parent', {
        kind: value,
        attributes: { [testKey1]: 'testValue1' },
      });
      const spanWithOpOnly: APISpan = tracer.startSpan('parent', {
        kind: value,
        attributes: { [testKey2]: 'testValue2' },
      });
      const spanWithAppAndOp: APISpan = tracer.startSpan('parent', {
        kind: value,
        attributes: {
          [testKey1]: 'testValue1',
          [testKey2]: 'testValue2',
        },
      });

      if (SpanKind.SERVER === value) {
        validateSpanAttributesInheritance(spanWithAppOnly, 'parent', undefined, undefined);
        validateSpanAttributesInheritance(spanWithOpOnly, 'parent', undefined, undefined);
        validateSpanAttributesInheritance(spanWithAppAndOp, 'parent', undefined, undefined);
      } else if (SpanKind.INTERNAL === value) {
        validateSpanAttributesInheritance(spanWithAppOnly, 'InternalOperation', 'testValue1', undefined);
        validateSpanAttributesInheritance(spanWithOpOnly, 'InternalOperation', undefined, 'testValue2');
        validateSpanAttributesInheritance(spanWithAppAndOp, 'InternalOperation', 'testValue1', 'testValue2');
      } else {
        validateSpanAttributesInheritance(spanWithOpOnly, 'InternalOperation', undefined, undefined);
        validateSpanAttributesInheritance(spanWithAppOnly, 'InternalOperation', undefined, undefined);
        validateSpanAttributesInheritance(spanWithAppAndOp, 'InternalOperation', undefined, undefined);
      }
    });
  });

  it('testAttributesPropagationWithInternalKinds', () => {
    const grandParentSpan: APISpan = tracer.startSpan('grandparent', {
      kind: SpanKind.INTERNAL,
      attributes: { [testKey1]: 'testValue1' },
    });
    const parentSpan: APISpan = tracer.startSpan(
      'parent',
      { kind: SpanKind.INTERNAL, attributes: { [testKey2]: 'testValue2' } },
      trace.setSpan(context.active(), grandParentSpan)
    );
    const childSpan: APISpan = tracer.startSpan(
      'child',
      { kind: SpanKind.CLIENT },
      trace.setSpan(context.active(), parentSpan)
    );
    const grandchildSpan: APISpan = tracer.startSpan(
      'child',
      { kind: SpanKind.INTERNAL },
      trace.setSpan(context.active(), childSpan)
    );

    const grandParentReadableSpan: APISpan = grandParentSpan as APISpan;
    const parentReadableSpan: APISpan = parentSpan as APISpan;
    const childReadableSpan: APISpan = childSpan as APISpan;
    const grandchildReadableSpan: APISpan = grandchildSpan as APISpan;

    expect((grandParentReadableSpan as any).attributes[testKey1]).toEqual('testValue1');
    expect((grandParentReadableSpan as any).attributes[testKey2]).toBeUndefined();
    expect((parentReadableSpan as any).attributes[testKey1]).toEqual('testValue1');
    expect((parentReadableSpan as any).attributes[testKey2]).toEqual('testValue2');
    expect((childReadableSpan as any).attributes[testKey1]).toEqual('testValue1');
    expect((childReadableSpan as any).attributes[testKey2]).toEqual('testValue2');
    expect((grandchildReadableSpan as any).attributes[testKey1]).toBeUndefined();
    expect((grandchildReadableSpan as any).attributes[testKey2]).toBeUndefined();
  });

  it('testOverrideAttributes', () => {
    const parentSpan: APISpan = tracer.startSpan('parent', { kind: SpanKind.SERVER });

    parentSpan.setAttribute(testKey1, 'testValue1');
    parentSpan.setAttribute(testKey2, 'testValue2');

    const transmitSpans1: APISpan = createNestedSpan(parentSpan, 2);

    const childSpan: APISpan = tracer.startSpan('parent', undefined, trace.setSpan(context.active(), transmitSpans1));

    childSpan.setAttribute(testKey2, 'testValue3');

    const transmitSpans2: APISpan = createNestedSpan(childSpan, 2);

    expect((transmitSpans2 as any).attributes[testKey2]).toEqual('testValue3');
  });

  it('testSpanNamePropagationBySpanKind', () => {
    SPAN_KINDS.forEach((value: SpanKind) => {
      const span: APISpan = tracer.startSpan('parent', { kind: value });

      if (value === SpanKind.SERVER) {
        validateSpanAttributesInheritance(span, 'parent', undefined, undefined);
      } else {
        validateSpanAttributesInheritance(span, 'InternalOperation', undefined, undefined);
      }
    });
  });

  it('testSpanNamePropagationWithRemoteParentSpan', () => {
    const remoteParentContext: SpanContext = {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000002',
      traceFlags: TraceFlags.SAMPLED,
      traceState: createTraceState(),
      isRemote: true,
    };
    const remoteParentSpan: APISpan = {
      spanContext: () => remoteParentContext,
      setAttribute: (key: string, value: AttributeValue) => remoteParentSpan,
      setAttributes: (attributes: SpanAttributes) => remoteParentSpan,
      addEvent: (name: string, attributesOrStartTime?: SpanAttributes | TimeInput, startTime?: TimeInput) =>
        remoteParentSpan,
      addLink: (link: Link) => remoteParentSpan,
      addLinks: (links: Link[]) => remoteParentSpan,
      setStatus: (status: SpanStatus) => remoteParentSpan,
      updateName: (name: string) => remoteParentSpan,
      end: (endTime?: TimeInput) => remoteParentSpan,
      isRecording: () => true,
      recordException: (exception: Exception, time?: TimeInput) => {
        return;
      },
    };
    (remoteParentSpan as any).attributes = {};

    const span: APISpan = tracer.startSpan(
      'parent',
      { kind: SpanKind.SERVER },
      trace.setSpan(context.active(), remoteParentSpan)
    );
    validateSpanAttributesInheritance(span, 'parent', undefined, undefined);
  });

  it('testAwsSdkDescendantSpan', () => {
    const awsSdkSpan: APISpan = tracer.startSpan('parent', { kind: SpanKind.CLIENT });

    awsSdkSpan.setAttribute(SEMATTRS_RPC_SYSTEM, 'aws-api');
    expect((awsSdkSpan as any).attributes[AWS_ATTRIBUTE_KEYS.AWS_SDK_DESCENDANT]).toBeUndefined();

    const childSpan: APISpan = createNestedSpan(awsSdkSpan, 1);
    expect((childSpan as any).attributes[AWS_ATTRIBUTE_KEYS.AWS_SDK_DESCENDANT]).not.toBeUndefined();
    expect((childSpan as any).attributes[AWS_ATTRIBUTE_KEYS.AWS_SDK_DESCENDANT]).toEqual('true');
  });

  it('testConsumerParentSpanKindAttributePropagation', () => {
    const grandParentSpan: APISpan = tracer.startSpan('grandparent', { kind: SpanKind.CONSUMER });
    const parentSpan: APISpan = tracer.startSpan(
      'parent',
      { kind: SpanKind.INTERNAL },
      trace.setSpan(context.active(), grandParentSpan)
    );

    const childSpan: APISpan = tracer.startSpan(
      'child',
      { kind: SpanKind.CONSUMER, attributes: { [SEMATTRS_MESSAGING_OPERATION]: MESSAGINGOPERATIONVALUES_PROCESS } },
      trace.setSpan(context.active(), parentSpan)
    );

    expect((parentSpan as any).attributes[AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND]).toBeUndefined();
    expect((childSpan as any).attributes[AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND]).toBeUndefined();
  });

  it('testNoConsumerParentSpanKindAttributeWithConsumerProcess', () => {
    const parentSpan: APISpan = tracer.startSpan('parent', { kind: SpanKind.SERVER });

    const span: APISpan = tracer.startSpan(
      'parent',
      { kind: SpanKind.CONSUMER, attributes: { [SEMATTRS_MESSAGING_OPERATION]: MESSAGINGOPERATIONVALUES_PROCESS } },
      trace.setSpan(context.active(), parentSpan)
    );

    expect((span as any).attributes[AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND]).toBeUndefined();
  });

  it('testConsumerParentSpanKindAttributeWithConsumerParent', () => {
    const parentSpan: APISpan = tracer.startSpan('parent', { kind: SpanKind.CONSUMER });

    const span: APISpan = tracer.startSpan(
      'parent',
      { kind: SpanKind.CONSUMER },
      trace.setSpan(context.active(), parentSpan)
    );

    expect((span as any).attributes[AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND]).toEqual(
      SpanKind[SpanKind.CONSUMER]
    );
  });

  it('testLambdaResourceIdAttributeExist', () => {
    const parentSpan: APISpan = tracer.startSpan('parent', { kind: SpanKind.SERVER });

    parentSpan.setAttribute(AwsSpanProcessingUtil.CLOUD_RESOURCE_ID, 'resource-123');

    const childSpan: APISpan = createNestedSpan(parentSpan, 1);
    expect((childSpan as any).attributes[AwsSpanProcessingUtil.CLOUD_RESOURCE_ID]).not.toBeUndefined();
    expect((childSpan as any).attributes[AwsSpanProcessingUtil.CLOUD_RESOURCE_ID]).toEqual('resource-123');
  });

  it('testLambdaFaasIdAttributeExist', () => {
    const parentSpan: APISpan = tracer.startSpan('parent', { kind: SpanKind.SERVER });

    parentSpan.setAttribute('faas.id', 'faas-123');

    const childSpan: APISpan = createNestedSpan(parentSpan, 1);
    expect((childSpan as any).attributes['faas.id']).not.toBeUndefined();
    expect((childSpan as any).attributes['faas.id']).toEqual('faas-123');
  });

  it('testBothLambdaFaasIdAndResourceIdAttributesExist', () => {
    const parentSpan: APISpan = tracer.startSpan('parent', { kind: SpanKind.SERVER });

    parentSpan.setAttribute('faas.id', 'faas-123');
    parentSpan.setAttribute(AwsSpanProcessingUtil.CLOUD_RESOURCE_ID, 'resource-123');

    const childSpan: APISpan = createNestedSpan(parentSpan, 1);
    expect((childSpan as any).attributes[AwsSpanProcessingUtil.CLOUD_RESOURCE_ID]).not.toBeUndefined();
    expect((childSpan as any).attributes[AwsSpanProcessingUtil.CLOUD_RESOURCE_ID]).toEqual('resource-123');
  });

  it('testLambdaNoneResourceAttributesExist', () => {
    const parentSpan: APISpan = tracer.startSpan('parent', { kind: SpanKind.SERVER });

    const childSpan: APISpan = createNestedSpan(parentSpan, 1);
    expect((childSpan as any).attributes[AwsSpanProcessingUtil.CLOUD_RESOURCE_ID]).toBeUndefined();
  });

  function createNestedSpan(parentSpan: APISpan, depth: number): APISpan {
    if (depth === 0) {
      return parentSpan;
    }
    const childSpan: APISpan = tracer.startSpan(
      'child:' + depth,
      undefined,
      trace.setSpan(context.active(), parentSpan)
    );
    try {
      return createNestedSpan(childSpan, depth - 1);
    } finally {
      childSpan.end();
    }
  }

  function validateSpanAttributesInheritance(
    parentSpan: APISpan,
    propagatedName: string,
    propagationValue1: string | undefined,
    propagatedValue2: string | undefined
  ): void {
    const leafSpan: APISpan = createNestedSpan(parentSpan, 10) as APISpan;

    expect((leafSpan as any).name).toEqual('child:1');
    if (propagatedName !== undefined) {
      expect((leafSpan as any).attributes[spanNameKey]).toEqual(propagatedName);
    } else {
      expect((leafSpan as any).attributes[spanNameKey]).toBeUndefined();
    }
    if (propagationValue1 !== undefined) {
      expect((leafSpan as any).attributes[testKey1]).toEqual(propagationValue1);
    } else {
      expect((leafSpan as any).attributes[testKey1]).toBeUndefined();
    }
    if (propagatedValue2 !== undefined) {
      expect((leafSpan as any).attributes[testKey2]).toEqual(propagatedValue2);
    } else {
      expect((leafSpan as any).attributes[testKey2]).toBeUndefined();
    }
  }
});
