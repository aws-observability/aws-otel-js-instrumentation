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

import { Histogram, Meter, MeterProvider, MetricOptions } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { AwsMetricAttributeGenerator } from './aws-metric-attribute-generator';
import { AwsSpanMetricsProcessor } from './aws-span-metrics-processor';
import { MetricAttributeGenerator } from './metric-attribute-generator';

// Metric instrument configuration constants
const ERROR: string = 'Error';
const FAULT: string = 'Fault';
const LATENCY: string = 'Latency';
const LATENCY_UNITS: string = 'Milliseconds';

/** A builder for {@link AwsSpanMetricsProcessor} */
export class AwsSpanMetricsProcessorBuilder {
  // Defaults
  private static DEFAULT_GENERATOR: MetricAttributeGenerator = new AwsMetricAttributeGenerator();
  private static DEFAULT_SCOPE_NAME: string = 'AwsSpanMetricsProcessor';

  // Required builder elements
  private meterProvider: MeterProvider;
  private resource: Resource;

  // Optional builder elements
  private generator: MetricAttributeGenerator = AwsSpanMetricsProcessorBuilder.DEFAULT_GENERATOR;
  private scopeName: string = AwsSpanMetricsProcessorBuilder.DEFAULT_SCOPE_NAME;

  public static create(meterProvider: MeterProvider, resource: Resource): AwsSpanMetricsProcessorBuilder {
    return new AwsSpanMetricsProcessorBuilder(meterProvider, resource);
  }

  private constructor(meterProvider: MeterProvider, resource: Resource) {
    this.meterProvider = meterProvider;
    this.resource = resource;
  }

  /**
   * Sets the generator used to generate attributes used in metrics produced by span metrics
   * processor. If unset, defaults to {@link DEFAULT_GENERATOR}. Must not be null.
   */
  public setGenerator(generator: MetricAttributeGenerator): AwsSpanMetricsProcessorBuilder {
    this.generator = generator;
    return this;
  }

  /**
   * Sets the scope name used in the creation of metrics by the span metrics processor. If unset,
   * defaults to {@link DEFAULT_SCOPE_NAME}. Must not be null.
   */
  public setScopeName(scopeName: string): AwsSpanMetricsProcessorBuilder {
    this.scopeName = scopeName;
    return this;
  }

  public build(): AwsSpanMetricsProcessor {
    const meter: Meter = this.meterProvider.getMeter(this.scopeName);
    const errorHistogram: Histogram = meter.createHistogram(ERROR);
    const faultHistogram: Histogram = meter.createHistogram(FAULT);

    const metricOptions: MetricOptions = {
      unit: LATENCY_UNITS,
    };
    const latencyHistogram: Histogram = meter.createHistogram(LATENCY, metricOptions);

    return AwsSpanMetricsProcessor.create(errorHistogram, faultHistogram, latencyHistogram, this.generator, this.resource);
  }
}
