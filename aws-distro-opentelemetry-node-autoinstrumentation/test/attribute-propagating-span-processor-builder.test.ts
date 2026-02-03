// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SpanContext, SpanKind, SpanStatus } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import expect from 'expect';
import { AttributePropagatingSpanProcessor } from '../src/attribute-propagating-span-processor';
import { AttributePropagatingSpanProcessorBuilder } from '../src/attribute-propagating-span-processor-builder';

// Create a mock ReadableSpan object for testing
function createMockReadableSpan(): ReadableSpan {
  return {
    name: 'test-span',
    kind: SpanKind.INTERNAL,
    spanContext: () =>
      ({
        traceId: '00000000000000000000000000000001',
        spanId: '0000000000000001',
        traceFlags: 0,
      } as SpanContext),
    parentSpanContext: undefined,
    startTime: [0, 0],
    endTime: [0, 1],
    status: { code: 0 } as SpanStatus,
    attributes: {},
    links: [],
    events: [],
    duration: [0, 1],
    ended: true,
    resource: resourceFromAttributes({}),
    instrumentationScope: { name: 'test' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as ReadableSpan;
}

describe('AttributePropagatingSpanProcessorBuilderTest', () => {
  it('BasicTest', () => {
    const builder: AttributePropagatingSpanProcessorBuilder = AttributePropagatingSpanProcessorBuilder.create();
    expect(builder.setPropagationDataKey('test')).toBe(builder);

    function mock_extractor(_: ReadableSpan): string {
      return 'test';
    }

    expect(builder.setPropagationDataExtractor(mock_extractor)).toBe(builder);
    expect(builder.setAttributesKeysToPropagate(['test'])).toBe(builder);
    const spanProcessor: AttributePropagatingSpanProcessor = builder.build();
    expect((spanProcessor as any).propagationDataKey).toBe('test');
    expect((spanProcessor as any).propagationDataExtractor(createMockReadableSpan())).toEqual('test');
    expect((spanProcessor as any).attributesKeysToPropagate).toEqual(['test']);
  });

  it('throws errors when expected to', () => {
    const builder: AttributePropagatingSpanProcessorBuilder = AttributePropagatingSpanProcessorBuilder.create();
    expect(() => builder.setPropagationDataExtractor(undefined as any)).toThrow();
    expect(() => builder.setPropagationDataKey(undefined as any)).toThrow();
    expect(() => builder.setAttributesKeysToPropagate(undefined as any)).toThrow();
  });
});
