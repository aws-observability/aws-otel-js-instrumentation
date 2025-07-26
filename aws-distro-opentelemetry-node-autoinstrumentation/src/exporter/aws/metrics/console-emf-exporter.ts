// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AggregationSelector, AggregationTemporalitySelector } from '@opentelemetry/sdk-metrics';
import type { LogEvent } from '@aws-sdk/client-cloudwatch-logs';
import { EMFExporterBase } from './emf-exporter-base';

/**
 * OpenTelemetry metrics exporter for CloudWatch EMF format to console output.
 *
 * This exporter converts OTel metrics into CloudWatch EMF logs and writes them
 * to standard output instead of sending to CloudWatch Logs. This is useful for
 * debugging, testing, or when you want to process EMF logs with other tools.
 *
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */
export class ConsoleEMFExporter extends EMFExporterBase {
  /**
   * Constructor for the Console EMF exporter.
   *
   * @param namespace CloudWatch namespace for metrics (defaults to "default")
   * @param aggregationTemporalitySelector Optional Aggregation temporality selector based on metric instrument types.
   * @param aggregationSelector Optional Aggregation selector based on metric instrument types
   */
  constructor(
    namespace: string = 'default',
    aggregationTemporalitySelector?: AggregationTemporalitySelector,
    aggregationSelector?: AggregationSelector
  ) {
    super(namespace, aggregationTemporalitySelector, aggregationSelector);
  }

  /**
   * This method writes the EMF log message to stdout, making it easy to
   * capture and redirect the output for processing or debugging purposes.
   *
   * @param logEvent The log event containing the message to send
   * @returns {Promise<void>}
   */
  protected async sendLogEvent(logEvent: Required<LogEvent>) {
    console.log(logEvent.message);
  }

  /**
   * Force flush any pending metrics.
   * For this exporter, there is nothing to forceFlush.
   */
  public async forceFlush(): Promise<void> {}

  /**
   * Shutdown the exporter.
   * For this exporter, there is nothing to clean-up in order to shutdown.
   */
  public async shutdown(): Promise<void> {}
}
