// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

export const SERVICE_METRIC: string = 'Service';
export const DEPENDENCY_METRIC: string = 'Dependency';

export interface AttributeMap {
  [attributeKey: string]: Attributes;
}

/**
 * Metric attribute generator defines an interface for classes that can generate specific attributes
 * to be used by an {@link AwsSpanMetricsProcessor} to produce metrics and by
 * {@link AwsMetricAttributesSpanExporter} to wrap the original span.
 */
export interface MetricAttributeGenerator {
  /**
   * Given a span and associated resource, produce meaningful metric attributes for metrics produced
   * from the span. If no metrics should be generated from this span, return an empty Attributes={}.
   *
   * @param span - SpanData to be used to generate metric attributes.
   * @param resource - Resource associated with Span to be used to generate metric attributes.
   * @return A map of Attributes objects0 with values assigned to key "Service" or "Dependency". It
   *     will contain either 0, 1, or 2 items.
   */
  generateMetricAttributeMapFromSpan(span: ReadableSpan, resource: Resource): AttributeMap;
}
