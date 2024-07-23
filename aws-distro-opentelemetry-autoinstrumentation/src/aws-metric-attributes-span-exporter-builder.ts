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

import { Resource } from '@opentelemetry/resources';
import { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { AwsMetricAttributeGenerator } from './aws-metric-attribute-generator';
import { AwsMetricAttributesSpanExporter } from './aws-metric-attributes-span-exporter';
import { MetricAttributeGenerator } from './metric-attribute-generator';

export class AwsMetricAttributesSpanExporterBuilder {
  // Defaults
  private static DEFAULT_GENERATOR: MetricAttributeGenerator = new AwsMetricAttributeGenerator();

  // Required builder elements
  private delegate: SpanExporter;
  private resource: Resource;

  // Optional builder elements
  private generator: MetricAttributeGenerator = AwsMetricAttributesSpanExporterBuilder.DEFAULT_GENERATOR;

  public static create(delegate: SpanExporter, resource: Resource): AwsMetricAttributesSpanExporterBuilder {
    return new AwsMetricAttributesSpanExporterBuilder(delegate, resource);
  }

  private constructor(delegate: SpanExporter, resource: Resource) {
    this.delegate = delegate;
    this.resource = resource;
  }

  /**
   * Sets the generator used to generate attributes used spancs exported by the exporter. If unset,
   * defaults to {@link DEFAULT_GENERATOR}. Must not be null.
   */
  public setGenerator(generator: MetricAttributeGenerator): AwsMetricAttributesSpanExporterBuilder {
    this.generator = generator;
    return this;
  }

  public build(): AwsMetricAttributesSpanExporter {
    return AwsMetricAttributesSpanExporter.create(this.delegate, this.generator, this.resource);
  }
}
