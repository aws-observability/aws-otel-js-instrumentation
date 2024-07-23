/*
 * Copyright Amazon.com, Inc. or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

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
