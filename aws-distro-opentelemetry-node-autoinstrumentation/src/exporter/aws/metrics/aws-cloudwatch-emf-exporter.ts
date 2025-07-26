// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { AggregationSelector, AggregationTemporalitySelector } from '@opentelemetry/sdk-metrics';
import { CloudWatchLogsClient } from './cloudwatch-logs-client';
import type { LogEvent, CloudWatchLogsClientConfig } from '@aws-sdk/client-cloudwatch-logs';
import { EMFExporterBase } from './emf-exporter-base';

/**
 * OpenTelemetry metrics exporter for CloudWatch EMF format.
 *
 * This exporter converts OTel metrics into CloudWatch EMF logs which are then
 * sent to CloudWatch Logs. CloudWatch Logs automatically extracts the metrics
 * from the EMF logs.
 */
export class AWSCloudWatchEMFExporter extends EMFExporterBase {
  private logClient: CloudWatchLogsClient;

  constructor(
    namespace: string = 'default',
    logGroupName: string,
    logStreamName?: string,
    aggregationTemporalitySelector?: AggregationTemporalitySelector,
    aggregationSelector?: AggregationSelector,
    cloudwatchLogsConfig: CloudWatchLogsClientConfig = {}
  ) {
    super(namespace, aggregationTemporalitySelector, aggregationSelector);

    this.logClient = new CloudWatchLogsClient(logGroupName, logStreamName, cloudwatchLogsConfig);
  }

  /**
   * Send a log event to CloudWatch Logs using the log client.
   *
   * @param logEvent The log event to send
   * @returns {Promise<void>}
   */
  protected async sendLogEvent(logEvent: Required<LogEvent>) {
    await this.logClient.sendLogEvent(logEvent);
  }

  /**
   * Force flush any pending metrics.
   */
  public async forceFlush(): Promise<void> {
    await this.logClient.flushPendingEvents();
    diag.debug('AWSCloudWatchEMFExporter force flushes the buffered metrics');
  }

  /**
   * Shutdown the exporter.
   */
  public async shutdown(): Promise<void> {
    await this.forceFlush();
    diag.debug('AWSCloudWatchEMFExporter shutdown called');
  }
}
