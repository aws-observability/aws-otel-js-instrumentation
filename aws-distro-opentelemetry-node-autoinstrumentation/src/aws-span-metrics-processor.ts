// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue, Attributes, Context, Histogram, SpanStatusCode } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SEMATTRS_HTTP_STATUS_CODE } from '@opentelemetry/semantic-conventions';
import { AttributeMap, MetricAttributeGenerator } from './metric-attribute-generator';
import { ForceFlushFunction } from "./aws-span-processing-util";

/**
 * This processor will generate metrics based on span data. It depends on a
 * {@link MetricAttributeGenerator} being provided on instantiation, which will provide a means to
 * determine attributes which should be used to create metrics. A {@link Resource} must also be
 * provided, which is used to generate metrics. Finally, three {@link Histogram}'s must be provided,
 * which will be used to actually create desired metrics (see below)
 *
 * <p>AwsSpanMetricsProcessor produces metrics for errors (e.g. HTTP 4XX status codes), faults (e.g.
 * HTTP 5XX status codes), and latency (in Milliseconds). Errors and faults are counted, while
 * latency is measured with a histogram. Metrics are emitted with attributes derived from span
 * attributes.
 *
 * <p>For highest fidelity metrics, this processor should be coupled with the {@link AlwaysRecordSampler},
 * which will result in 100% of spans being sent to the processor.
 */
export class AwsSpanMetricsProcessor implements SpanProcessor {
  private NANOS_TO_MILLIS_DIVIDER: number = 1_000_000.0;
  private SECONDS_TO_MILLIS_MULTIPLIER: number = 1_000.0;

  // Constants for deriving error and fault metrics
  private ERROR_CODE_LOWER_BOUND: number = 400;
  private ERROR_CODE_UPPER_BOUND: number = 499;
  private FAULT_CODE_LOWER_BOUND: number = 500;
  private FAULT_CODE_UPPER_BOUND: number = 599;

  // Metric instruments
  private errorHistogram: Histogram;
  private faultHistogram: Histogram;
  private latencyHistogram: Histogram;

  private generator: MetricAttributeGenerator;
  private resource: Resource;
  private forceFlushFunction: ForceFlushFunction;

  /** Use {@link AwsSpanMetricsProcessorBuilder} to construct this processor. */
  static create(
    errorHistogram: Histogram,
    faultHistogram: Histogram,
    latencyHistogram: Histogram,
    generator: MetricAttributeGenerator,
    resource: Resource,
    forceFlushFunction: ForceFlushFunction
  ): AwsSpanMetricsProcessor {
    return new AwsSpanMetricsProcessor(errorHistogram, faultHistogram, latencyHistogram, generator, resource, forceFlushFunction);
  }

  private constructor(
    errorHistogram: Histogram,
    faultHistogram: Histogram,
    latencyHistogram: Histogram,
    generator: MetricAttributeGenerator,
    resource: Resource,
    forceFlushFunction: ForceFlushFunction
  ) {
    this.errorHistogram = errorHistogram;
    this.faultHistogram = faultHistogram;
    this.latencyHistogram = latencyHistogram;
    this.generator = generator;
    this.resource = resource;
    this.forceFlushFunction = forceFlushFunction;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public onStart(span: Span, parentContext: Context): void {}

  public onEnd(span: ReadableSpan): void {
    const attributeMap: AttributeMap = this.generator.generateMetricAttributeMapFromSpan(span, this.resource);

    for (const attribute in attributeMap) {
      this.recordMetrics(span, attributeMap[attribute]);
    }
  }

  // The logic to record error and fault should be kept in sync with the aws-xray exporter whenever
  // possible except for the throttle
  // https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/awsxrayexporter/internal/translator/cause.go#L121-L160
  private recordErrorOrFault(spanData: ReadableSpan, attributes: Attributes): void {
    let httpStatusCode: AttributeValue | undefined = spanData.attributes[SEMATTRS_HTTP_STATUS_CODE];
    const statusCode: SpanStatusCode = spanData.status.code;

    if (typeof httpStatusCode !== 'number') {
      httpStatusCode = attributes[SEMATTRS_HTTP_STATUS_CODE];
    }

    if (
      typeof httpStatusCode !== 'number' ||
      httpStatusCode < this.ERROR_CODE_LOWER_BOUND ||
      httpStatusCode > this.FAULT_CODE_UPPER_BOUND
    ) {
      if (SpanStatusCode.ERROR === statusCode) {
        this.errorHistogram.record(0, attributes);
        this.faultHistogram.record(1, attributes);
      } else {
        this.errorHistogram.record(0, attributes);
        this.faultHistogram.record(0, attributes);
      }
    } else if (httpStatusCode >= this.ERROR_CODE_LOWER_BOUND && httpStatusCode <= this.ERROR_CODE_UPPER_BOUND) {
      this.errorHistogram.record(1, attributes);
      this.faultHistogram.record(0, attributes);
    } else if (httpStatusCode >= this.FAULT_CODE_LOWER_BOUND && httpStatusCode <= this.FAULT_CODE_UPPER_BOUND) {
      this.errorHistogram.record(0, attributes);
      this.faultHistogram.record(1, attributes);
    }
  }

  private recordLatency(span: ReadableSpan, attributes: Attributes): void {
    const millisFromSeconds: number = span.duration[0] * this.SECONDS_TO_MILLIS_MULTIPLIER;
    const millisFromNanos: number = span.duration[1] / this.NANOS_TO_MILLIS_DIVIDER;

    const millis: number = millisFromSeconds + millisFromNanos;
    this.latencyHistogram.record(millis, attributes);
  }

  private recordMetrics(span: ReadableSpan, attributes: Attributes): void {
    // Only record metrics if non-empty attributes are returned.
    if (Object.keys(attributes).length > 0) {
      this.recordErrorOrFault(span, attributes);
      this.recordLatency(span, attributes);
    }
  }

  public shutdown(): Promise<void> {
    return this.forceFlush();
  }

  public forceFlush(): Promise<void> {
    return this.forceFlushFunction()
  }
}
