// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import expect from 'expect';
import * as sinon from 'sinon';
import { AttributePropagatingSpanProcessor } from '../src/attribute-propagating-span-processor';
import { AttributePropagatingSpanProcessorBuilder } from '../src/attribute-propagating-span-processor-builder';

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
    expect((spanProcessor as any).propagationDataExtractor(sinon.createStubInstance(Span))).toEqual('test');
    expect((spanProcessor as any).attributesKeysToPropagate).toEqual(['test']);
  });

  it('throws errors when expected to', () => {
    const builder: AttributePropagatingSpanProcessorBuilder = AttributePropagatingSpanProcessorBuilder.create();
    expect(() => builder.setPropagationDataExtractor(undefined as any)).toThrow();
    expect(() => builder.setPropagationDataKey(undefined as any)).toThrow();
    expect(() => builder.setAttributesKeysToPropagate(undefined as any)).toThrow();
  });
});
