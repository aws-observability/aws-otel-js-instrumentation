// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes } from '@opentelemetry/api';
import { ExportResult } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { AWS_ATTRIBUTE_KEYS } from './aws-attribute-keys';
import { AwsSpanProcessingUtil } from './aws-span-processing-util';
import {
  AttributeMap,
  DEPENDENCY_METRIC,
  MetricAttributeGenerator,
  SERVICE_METRIC,
} from './metric-attribute-generator';

/**
 * This exporter will update a span with metric attributes before exporting. It depends on a
 * {@link SpanExporter} being provided on instantiation, which the AwsMetricAttributesSpanExporter will
 * delegate export to. Also, a {@link MetricAttributeGenerator} must be provided, which will provide a
 * means to determine attributes which should be applied to the span. Finally, a {@link Resource} must
 * be provided, which is used to generate metric attributes.
 *
 * <p>This exporter should be coupled with the {@link AwsSpanMetricsProcessor} using the same
 * {@link MetricAttributeGenerator}. This will result in metrics and spans being produced with
 * common attributes.
 */
export class AwsMetricAttributesSpanExporter implements SpanExporter {
  private delegate: SpanExporter;
  private generator: MetricAttributeGenerator;
  private resource: Resource;

  /** Use {@link AwsMetricAttributesSpanExporterBuilder} to construct this exporter. */
  static create(
    delegate: SpanExporter,
    generator: MetricAttributeGenerator,
    resource: Resource
  ): AwsMetricAttributesSpanExporter {
    return new AwsMetricAttributesSpanExporter(delegate, generator, resource);
  }

  private constructor(delegate: SpanExporter, generator: MetricAttributeGenerator, resource: Resource) {
    this.delegate = delegate;
    this.generator = generator;
    this.resource = resource;
  }

  public export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const modifiedSpans: ReadableSpan[] = this.addMetricAttributes(spans);
    this.delegate.export(modifiedSpans, resultCallback);
  }

  public shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  public forceFlush(): Promise<void> {
    if (this.delegate.forceFlush !== undefined) {
      return this.delegate.forceFlush();
    }
    return Promise.resolve();
  }

  private addMetricAttributes(spans: ReadableSpan[]): ReadableSpan[] {
    const modifiedSpans: ReadableSpan[] = [];

    spans.forEach((span: ReadableSpan) => {
      // If the map has no items, no modifications are required. If there is one item, it means the
      // span either produces Service or Dependency metric attributes, and in either case we want to
      // modify the span with them. If there are two items, the span produces both Service and
      // Dependency metric attributes indicating the span is a local dependency root. The Service
      // Attributes must be a subset of the Dependency, with the exception of AWS_SPAN_KIND. The
      // knowledge that the span is a local root is more important that knowing that it is a
      // Dependency metric, so we take all the Dependency metrics but replace AWS_SPAN_KIND with
      // LOCAL_ROOT.

      const attributeMap: AttributeMap = this.generator.generateMetricAttributeMapFromSpan(span, this.resource);
      let attributes: Attributes | undefined = {};

      const generatesServiceMetrics: boolean = AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(span);
      const generatesDependencyMetrics: boolean = AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(span);

      if (generatesServiceMetrics && generatesDependencyMetrics) {
        attributes = this.copyAttributesWithLocalRoot(attributeMap[DEPENDENCY_METRIC]);
      } else if (generatesServiceMetrics) {
        attributes = attributeMap[SERVICE_METRIC];
      } else if (generatesDependencyMetrics) {
        attributes = attributeMap[DEPENDENCY_METRIC];
      }

      if (attributes !== undefined && Object.keys(attributes).length > 0) {
        span = AwsMetricAttributesSpanExporter.wrapSpanWithAttributes(span, attributes);
      }
      modifiedSpans.push(span);
    });

    return modifiedSpans;
  }

  private copyAttributesWithLocalRoot(attributes: Attributes): Attributes {
    const updatedAttributes: Attributes = { ...attributes };
    delete updatedAttributes[AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND];
    updatedAttributes[AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND] = AwsSpanProcessingUtil.LOCAL_ROOT;
    return updatedAttributes;
  }

  /**
   * {@link export} works with a {@link ReadableSpan}, which does not permit modification. However, we
   * need to add derived metric attributes to the span. However, we are still able to modify the
   * attributes in the span (the attributes itself is readonly, so it cannot be outright replaced).
   * This may be risky.
   *
   * <p>See https://github.com/open-telemetry/opentelemetry-specification/issues/1089 for more
   * context on this approach.
   */
  private static wrapSpanWithAttributes(span: ReadableSpan, attributes: Attributes): ReadableSpan {
    const originalAttributes: Attributes = span.attributes;
    const updateAttributes: Attributes = {};

    for (const key in originalAttributes) {
      updateAttributes[key] = originalAttributes[key];
    }
    for (const key in attributes) {
      updateAttributes[key] = attributes[key];
    }

    // Bypass `readonly` restriction of ReadableSpan's attributes.
    // Workaround provided from official TypeScript docs:
    // https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-8.html#improved-control-over-mapped-type-modifiers
    type Mutable<T> = { -readonly [P in keyof T]: T[P] };
    const mutableSpan: Mutable<ReadableSpan> = span;
    mutableSpan.attributes = updateAttributes;

    return span;
  }
}
