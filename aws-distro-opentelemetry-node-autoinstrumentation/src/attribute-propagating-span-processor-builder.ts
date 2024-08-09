// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { AttributePropagatingSpanProcessor } from './attribute-propagating-span-processor';
import { AWS_ATTRIBUTE_KEYS } from './aws-attribute-keys';
import { AwsSpanProcessingUtil } from './aws-span-processing-util';

/**
 * AttributePropagatingSpanProcessorBuilder is used to construct a {@link AttributePropagatingSpanProcessor}.
 * If {@link setPropagationDataExtractor}, {@link setPropagationDataKey} or {@link setAttributesKeysToPropagate}
 * are not invoked, the builder defaults to using specific propagation targets.
 */
export class AttributePropagatingSpanProcessorBuilder {
  private propagationDataExtractor: (span: ReadableSpan) => string = AwsSpanProcessingUtil.getIngressOperation;
  private propagationDataKey: string = AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION;
  private attributesKeysToPropagate: string[] = [
    AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE,
    AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION,
  ];

  public static create(): AttributePropagatingSpanProcessorBuilder {
    return new AttributePropagatingSpanProcessorBuilder();
  }

  private constructor() {}

  public setPropagationDataExtractor(
    propagationDataExtractor: (span: ReadableSpan) => string
  ): AttributePropagatingSpanProcessorBuilder {
    if (propagationDataExtractor == null) {
      throw new Error('propagationDataExtractor must not be null');
    }
    this.propagationDataExtractor = propagationDataExtractor;
    return this;
  }

  public setPropagationDataKey(propagationDataKey: string): AttributePropagatingSpanProcessorBuilder {
    if (propagationDataKey == null) {
      throw new Error('propagationDataKey must not be null');
    }
    this.propagationDataKey = propagationDataKey;
    return this;
  }

  public setAttributesKeysToPropagate(attributesKeysToPropagate: string[]): AttributePropagatingSpanProcessorBuilder {
    if (attributesKeysToPropagate == null) {
      throw new Error('attributesKeysToPropagate must not be null');
    }
    this.attributesKeysToPropagate = [...attributesKeysToPropagate];
    return this;
  }

  public build(): AttributePropagatingSpanProcessor {
    return AttributePropagatingSpanProcessor.create(
      this.propagationDataExtractor,
      this.propagationDataKey,
      this.attributesKeysToPropagate
    );
  }
}
