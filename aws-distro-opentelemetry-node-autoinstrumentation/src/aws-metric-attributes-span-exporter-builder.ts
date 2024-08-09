// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
    if (generator == null) {
      throw new Error('generator must not be null/undefined');
    }
    this.generator = generator;
    return this;
  }

  public build(): AwsMetricAttributesSpanExporter {
    return AwsMetricAttributesSpanExporter.create(this.delegate, this.generator, this.resource);
  }
}
