// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Span as APISpan, AttributeValue, Context, SpanKind, trace } from '@opentelemetry/api';
import { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AWS_ATTRIBUTE_KEYS } from './aws-attribute-keys';
import { AwsSpanProcessingUtil } from './aws-span-processing-util';

/**
 * AttributePropagatingSpanProcessor handles the propagation of attributes from parent spans to
 * child spans, specified in {@link attributesKeysToPropagate}. AttributePropagatingSpanProcessor
 * also propagates configurable data from parent spans to child spans, as a new attribute specified
 * by {@link propagationDataKey}. Propagated data can be configured via the {@link propagationDataExtractor}.
 * Span data propagation only starts from local root server/consumer spans, but from there will
 * be propagated to any descendant spans. If the span is a CONSUMER PROCESS with the parent also
 * a CONSUMER, it will set attribute AWS_CONSUMER_PARENT_SPAN_KIND as CONSUMER to indicate that
 * dependency metrics should not be generated for this span.
 */
export class AttributePropagatingSpanProcessor implements SpanProcessor {
  private propagationDataExtractor: (span: ReadableSpan) => string;

  private propagationDataKey: string;
  private attributesKeysToPropagate: string[];

  public static create(
    propagationDataExtractor: (span: ReadableSpan) => string,
    propagationDataKey: string,
    attributesKeysToPropagate: string[]
  ): AttributePropagatingSpanProcessor {
    return new AttributePropagatingSpanProcessor(
      propagationDataExtractor,
      propagationDataKey,
      attributesKeysToPropagate
    );
  }

  private constructor(
    propagationDataExtractor: (span: ReadableSpan) => string,
    propagationDataKey: string,
    attributesKeysToPropagate: string[]
  ) {
    this.propagationDataExtractor = propagationDataExtractor;
    this.propagationDataKey = propagationDataKey;
    this.attributesKeysToPropagate = attributesKeysToPropagate;
  }

  public onStart(span: Span, parentContext: Context): void {
    // Divergence from Java/Python
    // Workaround implemented in TypeScript. Calculation of isLocalRoot is not possible
    // in `AwsSpanProcessingUtil.isLocalRoot` because the parent context is not accessible
    // from a span. Therefore we pre-calculate its value here as an attribute.
    AwsSpanProcessingUtil.setIsLocalRootInformation(span, parentContext);

    const parentSpan: APISpan | undefined = trace.getSpan(parentContext);
    let parentReadableSpan: Span | undefined = undefined;

    // In Python and Java, the check is "parentSpan is an instance of ReadableSpan" is not possible
    // in TypeScript because the check is not allowed for TypeScript interfaces (such as ReadableSpan).
    // This is because JavaScript doesn't support interfaces, which is what TypeScript will compile to.
    // `Span` is the only class that implements ReadableSpan, so check for instance of Span.
    if (parentSpan instanceof Span) {
      parentReadableSpan = parentSpan;

      // Add the AWS_SDK_DESCENDANT attribute to the immediate child spans of AWS SDK span.
      // This attribute helps the backend differentiate between SDK spans and their immediate
      // children.
      // It's assumed that the HTTP spans are immediate children of the AWS SDK span
      // TODO: we should have a contract test to check the immediate children are HTTP span
      if (AwsSpanProcessingUtil.isAwsSDKSpan(parentReadableSpan)) {
        span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_SDK_DESCENDANT, 'true');
      }

      if (SpanKind.INTERNAL === parentReadableSpan.kind) {
        for (const keyToPropagate of this.attributesKeysToPropagate) {
          const valueToPropagate: AttributeValue | undefined = parentReadableSpan.attributes[keyToPropagate];
          if (valueToPropagate !== undefined) {
            span.setAttribute(keyToPropagate, valueToPropagate);
          }
        }
      }

      // We cannot guarantee that messaging.operation is set onStart, it could be set after the fact.
      // To work around this, add the AWS_CONSUMER_PARENT_SPAN_KIND attribute if parent and child are
      // both CONSUMER then check later if a metric should be generated.
      if (this.isConsumerKind(span) && this.isConsumerKind(parentReadableSpan)) {
        span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND, SpanKind[parentReadableSpan.kind]);
      }
    }

    let propagationData: AttributeValue | undefined = undefined;
    if (AwsSpanProcessingUtil.isLocalRoot(span)) {
      if (!this.isServerKind(span)) {
        propagationData = this.propagationDataExtractor(span);
      }
    } else if (parentReadableSpan !== undefined && this.isServerKind(parentReadableSpan)) {
      // In TypeScript, perform `parentReadableSpan !== undefined` check
      // This should be done in Python and Java as well, but is not as of now
      // If parentReadableSpan is not defined, the first `if statement` should occur,
      // so that is why it is not a problem for Java/Python...
      propagationData = this.propagationDataExtractor(parentReadableSpan);
    } else {
      // In TypeScript, perform `parentReadableSpan?` check (returns undefined if undefined)
      // This should be done in Python and Java as well, but is not as of now
      propagationData = parentReadableSpan?.attributes[this.propagationDataKey];
    }

    if (propagationData !== undefined) {
      span.setAttribute(this.propagationDataKey, propagationData);
    }
  }

  private isConsumerKind(span: ReadableSpan): boolean {
    return SpanKind.CONSUMER === span.kind;
  }

  private isServerKind(span: ReadableSpan): boolean {
    return SpanKind.SERVER === span.kind;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public onEnd(span: ReadableSpan): void {}

  public shutdown(): Promise<void> {
    return this.forceFlush();
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
