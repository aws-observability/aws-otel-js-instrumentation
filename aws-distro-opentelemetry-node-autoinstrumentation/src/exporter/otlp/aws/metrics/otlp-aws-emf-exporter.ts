// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTelemetry EMF (Embedded Metric Format) Exporter for CloudWatch.
 * This exporter converts OTel metrics into CloudWatch EMF format.
 */
import { Attributes, context, diag, HrTime } from '@opentelemetry/api';
import type {
  CloudWatchLogsClientConfig,
  PutLogEventsCommandInput,
  CloudWatchLogs as CloudWatchLogsType,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  Aggregation,
  AggregationTemporality,
  DataPoint,
  DataPointType,
  GaugeMetricData,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { ExportResult, ExportResultCode, suppressTracing } from '@opentelemetry/core';
import * as Crypto from 'crypto';

// Constants for CloudWatch Logs limits
export const CW_MAX_EVENT_PAYLOAD_BYTES = 256 * 1024; // 256KB
export const CW_MAX_REQUEST_EVENT_COUNT = 10000;
export const CW_PER_EVENT_HEADER_BYTES = 26;
export const BATCH_FLUSH_INTERVAL = 60 * 1000;
export const CW_MAX_REQUEST_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB
export const CW_TRUNCATED_SUFFIX = '[Truncated...]';
export const CW_EVENT_TIMESTAMP_LIMIT_PAST = 14 * 24 * 60 * 60 * 1000; // 14 days in milliseconds
export const CW_EVENT_TIMESTAMP_LIMIT_FUTURE = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

export interface MetricRecord {
  name: string;
  unit: string;
  description: string;
  timestamp: number;
  attributes: Attributes;

  // Only one of the following should be defined
  sumData?: number;
  value?: number;
}

interface EMFLog {
  _aws: _Aws;
  [key: `otel.resource.${string}`]: string;
  [metricName: string]: any; // Can be any, but usually will be used for Metric Record Data
  Version: string;
}

interface _Aws {
  CloudWatchMetrics: CloudWatchMetric[];
  Timestamp: number;
}

interface CloudWatchMetric {
  Namespace: string;
  Dimensions: string[][];
  Metrics: Metric[];
}

interface Metric {
  Name: string;
  Unit?: string;
}

interface LogEvent {
  message: string;
  timestamp: number;
}

/**
 * OpenTelemetry metrics exporter for CloudWatch EMF format.
 *
 * This exporter converts OTel metrics into CloudWatch EMF logs which are then
 * sent to CloudWatch Logs. CloudWatch Logs automatically extracts the metrics
 * from the EMF logs.
 */
export class AWSCloudWatchEMFExporter implements PushMetricExporter {
  private namespace: string;
  private logGroupName: string;
  private logStreamName: string;
  private aggregationTemporality: AggregationTemporality;

  private logsClient: CloudWatchLogsType;
  private logStreamExists: boolean;
  private logStreamExistsPromise: Promise<void>;

  private EMF_SUPPORTED_UNITS: Set<string> = new Set<string>([
    'Seconds',
    'Microseconds',
    'Milliseconds',
    'Bytes',
    'Kilobytes',
    'Megabytes',
    'Gigabytes',
    'Terabytes',
    'Bits',
    'Kilobits',
    'Megabits',
    'Gigabits',
    'Terabits',
    'Percent',
    'Count',
    'Bytes/Second',
    'Kilobytes/Second',
    'Megabytes/Second',
    'Gigabytes/Second',
    'Terabytes/Second',
    'Bits/Second',
    'Kilobits/Second',
    'Megabits/Second',
    'Gigabits/Second',
    'Terabits/Second',
    'Count/Second',
    'None',
  ]);

  // OTel to CloudWatch unit mapping
  private UNIT_MAPPING: Map<string, string> = new Map<string, string>(
    Object.entries({
      '1': '',
      ns: '',
      ms: 'Milliseconds',
      s: 'Seconds',
      us: 'Microseconds',
      By: 'Bytes',
      bit: 'Bits',
    })
  );

  /**
   * Initialize the CloudWatch EMF exporter.
   *
   * @param namespace CloudWatch namespace for metrics
   * @param logGroupName CloudWatch log group name
   * @param logStreamName Optional CloudWatch log stream name (auto-generated if not provided)
   * @param AggregationTemporality Optional AggregationTemporality to indicate the way additive quantities are expressed
   * @param cloudwatchLogsConfig Optional CloudWatch Logs Client Configuration. Configure region here if needed explicitly.
   */
  constructor(
    namespace: string = 'default',
    logGroupName: string,
    logStreamName?: string,
    aggregationTemporality: AggregationTemporality = AggregationTemporality.DELTA,
    cloudwatchLogsConfig: CloudWatchLogsClientConfig = {}
  ) {
    this.namespace = namespace;
    this.logGroupName = logGroupName;
    this.logStreamName = logStreamName || this.generateLogStreamName();
    this.aggregationTemporality = aggregationTemporality;

    // Require CloudWatchLogs Client synchronously so AWS SDK isn't loaded before
    // any patching is done in the unit tests
    const { CloudWatchLogs } = require('@aws-sdk/client-cloudwatch-logs');
    this.logsClient = new CloudWatchLogs(cloudwatchLogsConfig);

    // Determine that Log group/stream exists asynchronously. The Constructor cannot wait on async
    // operations, so whether or not the group/stream actually exists will be determined later.
    this.logStreamExists = false;
    this.logStreamExistsPromise = this.ensureLogGroupExists().then(async () => {
      await this.ensureLogStreamExists();
    });
  }

  /**
   * Generate a unique log stream name.
   *
   * @returns {string}
   */
  private generateLogStreamName(): string {
    const uniqueId = Crypto.randomUUID().substring(0, 8);
    return `otel-js-${uniqueId}`;
  }

  /**
   * Ensure the log group exists, create if it doesn't.
   */
  private async ensureLogGroupExists() {
    try {
      await context.with(suppressTracing(context.active()), async () => {
        await this.logsClient.createLogGroup({
          logGroupName: this.logGroupName,
        });
      });
      diag.info(`Created log group: ${this.logGroupName}`);
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'ResourceAlreadyExistsException') {
        diag.info(`Log group ${this.logGroupName} already exists.`);
      } else {
        diag.error(`Error occurred when creating log group ${this.logGroupName}: ${e}`);
        throw e;
      }
    }
  }

  /**
   * Ensure the log stream exists, create if it doesn't.
   */
  private async ensureLogStreamExists() {
    try {
      await context.with(suppressTracing(context.active()), async () => {
        await this.logsClient.createLogStream({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
        });
      });
      diag.info(`Created log stream: ${this.logStreamName}`);
      this.logStreamExists = true;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'ResourceAlreadyExistsException') {
        diag.info(`Log stream ${this.logStreamName} already exists.`);
      } else {
        diag.error(`Error occurred when creating log stream "${this.logStreamName}": ${e}`);
        throw e;
      }
    }
  }

  /**
   * Get CloudWatch unit from unit in MetricRecord
   *
   * @param record Metric Record
   * @returns {string | undefined}
   */
  private getUnit(record: MetricRecord): string | undefined {
    const unit = record.unit;

    if (this.EMF_SUPPORTED_UNITS.has(unit)) {
      return unit;
    }

    return this.UNIT_MAPPING.get(unit);
  }

  /**
   * Extract dimension names from attributes.
   * For now, use all attributes as dimensions for the dimension selection logic.
   *
   * @param attributes OpenTelemetry Attributes to extract Dimension Names from
   * @returns {string[]}
   */
  private getDimensionNames(attributes: Attributes): string[] {
    return Object.keys(attributes);
  }

  /**
   * Create a hashable key from attributes for grouping metrics.
   *
   * @param attributes OpenTelemetry Attributes used to create an attributes key
   * @returns {string}
   */
  private getAttributesKey(attributes: Attributes): string {
    // Sort the attributes to ensure consistent keys
    const sortedAttrs = Object.entries(attributes).sort();
    // Create a string representation of the attributes
    return sortedAttrs.toString();
  }

  /**
   * Normalize an OpenTelemetry timestamp to milliseconds for CloudWatch.
   *
   * @param hrTime Datapoint timestamp
   * @returns {number} Timestamp in milliseconds
   */
  private normalizeTimestamp(hrTime: HrTime): number {
    // Convert from second and nanoseconds to milliseconds
    const secondsToMillis = hrTime[0] * 1000;
    const nanosToMillis = Math.floor(hrTime[1] / 1_000_000);
    return secondsToMillis + nanosToMillis;
  }

  /**
   * Create a base metric record with instrument information.
   *
   * @param metricName Name of the metric
   * @param metricUnit Unit of the metric
   * @param metricDescription Description of the metric
   * @param timestamp Normalized end epoch timestamp when metric data was collected
   * @param attributes Attributes of the metric data
   * @returns {MetricRecord}
   */
  private createMetricRecord(
    metricName: string,
    metricUnit: string,
    metricDescription: string,
    timestamp: number,
    attributes: Attributes
  ): MetricRecord {
    const record: MetricRecord = {
      name: metricName,
      unit: metricUnit,
      description: metricDescription,
      timestamp,
      attributes,
    };

    return record;
  }

  /**
   * Convert a Gauge metric datapoint to a metric record.
   *
   * @param metric Gauge Metric Data
   * @param dataPoint The datapoint to convert
   * @returns {MetricRecord}
   */
  private convertGauge(metric: GaugeMetricData, dataPoint: DataPoint<number>): MetricRecord {
    const timestampMs = this.normalizeTimestamp(dataPoint.endTime);
    // Create base record
    const metricRecord: MetricRecord = this.createMetricRecord(
      metric.descriptor.name,
      metric.descriptor.unit,
      metric.descriptor.description,
      timestampMs,
      dataPoint.attributes
    );
    metricRecord.value = dataPoint.value; // For Gauge, set the value directly

    return metricRecord;
  }

  /**
   * Group metric record by attributes and timestamp.
   *
   * @param record The metric record
   * @param timestampMs The timestamp in milliseconds
   * @returns {[string, number]} Values for the key to group metrics
   */
  private groupByAttributesAndTimestamp(record: MetricRecord): [string, number] {
    // Create a key for grouping based on attributes
    const attrsKey = this.getAttributesKey(record.attributes);
    return [attrsKey, record.timestamp];
  }

  /**
   * Create EMF log from metric records.
   * metricRecords is already grouped by attributes, so this
   * function creates a single EMF Log for these records.
   *
   * @param metricRecords List of MetricRecords
   * @param resource
   * @param timestamp
   * @returns {EMFLog}
   */
  private createEmfLog(
    metricRecords: MetricRecord[],
    resource: Resource,
    timestamp: number | undefined = undefined
  ): EMFLog {
    // Start with base structure
    const emfLog: EMFLog = {
      _aws: {
        Timestamp: timestamp || Date.now(),
        CloudWatchMetrics: [],
      },
      Version: '1',
    };

    // Add resource attributes to EMF log but not as dimensions
    if (resource && resource.attributes) {
      for (const [key, value] of Object.entries(resource.attributes)) {
        emfLog[`otel.resource.${key}`] = value?.toString() ?? 'undefined';
      }
    }
    // Initialize collections for dimensions and metrics
    // Attributes of each record in the list should be the same
    const allAttributes: Attributes = metricRecords.length > 0 ? metricRecords[0].attributes : {};
    const metricDefinitions = [];

    // Process each metric record
    for (const record of metricRecords) {
      const metricName = record.name;
      // Skip processing if metric name is falsy
      if (!metricName) {
        continue;
      }

      // Handle Gauge metrics - Store value directly in emfLog
      // TODO: Handle metrics other than for GAUGE
      if (record.value) {
        emfLog[metricName] = record.value;
      } else {
        diag.debug(`Skipping metric ${metricName} as it does not have valid metric value`);
        continue;
      }

      // Create metric data
      const metricData: Metric = {
        Name: metricName,
      };

      const unit = this.getUnit(record);
      if (unit) {
        metricData.Unit = unit;
      }
      // Add to metric definitions list
      metricDefinitions.push(metricData);
    }
    // Get dimension names from collected attributes
    const dimensionNames = this.getDimensionNames(allAttributes);

    // Add attribute values to the root of the EMF log
    for (const [name, value] of Object.entries(allAttributes)) {
      emfLog[name] = value?.toString() ?? 'undefined';
    }

    // Add the single dimension set to CloudWatch Metrics if we have dimensions and metrics
    if (dimensionNames && metricDefinitions) {
      emfLog._aws.CloudWatchMetrics.push({
        Namespace: this.namespace,
        Dimensions: [dimensionNames],
        Metrics: metricDefinitions,
      });
    }

    return emfLog;
  }

  /**
   * Method to handle safely pushing a MetricRecord into a Map of a Map of a list of MetricRecords
   *
   * @param groupedMetrics
   * @param groupAttribute
   * @param groupTimestamp
   * @param record
   */
  private pushMetricRecordIntoGroupedMetrics(
    groupedMetrics: Map<string, Map<number, MetricRecord[]>>,
    groupAttribute: string,
    groupTimestamp: number,
    record: MetricRecord
  ) {
    let metricsGroupedByAttribute = groupedMetrics.get(groupAttribute);
    if (!metricsGroupedByAttribute) {
      metricsGroupedByAttribute = new Map<number, MetricRecord[]>();
      groupedMetrics.set(groupAttribute, metricsGroupedByAttribute);
    }

    let metricsGroupedByAttributeAndTimestamp = metricsGroupedByAttribute.get(groupTimestamp);
    if (!metricsGroupedByAttributeAndTimestamp) {
      metricsGroupedByAttributeAndTimestamp = [];
      metricsGroupedByAttribute.set(groupTimestamp, metricsGroupedByAttributeAndTimestamp);
    }
    metricsGroupedByAttributeAndTimestamp.push(record);
  }

  /**
   * Export metrics as EMF logs to CloudWatch.
   * Groups metrics by attributes and timestamp before creating EMF logs.
   *
   * @param resourceMetrics Resource Metrics data containing scope metrics
   * @param resultCallback callback for when the export has completed
   * @returns {Promise<void>}
   */
  public async export(resourceMetrics: ResourceMetrics, resultCallback: (result: ExportResult) => void) {
    try {
      if (!resourceMetrics) {
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }

      // Process all metrics from resource metrics their scope metrics
      // The resource is now part of each resource_metrics object
      const resource = resourceMetrics.resource;

      for (const scopeMetrics of resourceMetrics.scopeMetrics /*resource_metrics.scope_metrics*/) {
        // Map of maps to group metrics by attributes and timestamp
        // Keys: (attributes_key, timestamp_ms)
        // Value: list of metric records
        const groupedMetrics = new Map<string, Map<number, MetricRecord[]>>();

        // Process all metrics in this scope
        for (const metric of scopeMetrics.metrics) {
          // Convert metrics to a format compatible with create_emf_log
          // Process metric.dataPoints for different metric types
          // TODO: Handle DataPointTypes other than GAUGE
          if (metric.dataPointType === DataPointType.GAUGE) {
            for (const dataPoint of metric.dataPoints) {
              const record = this.convertGauge(metric, dataPoint);
              const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record);
              this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
            }
          } else {
            // This else block should never run, all metric types are accounted for above
            diag.debug(`Unsupported Metric Type in metric: ${metric}`);
          }
        }

        const sendLogEventPromises: Promise<void>[] = [];
        // Now process each group separately to create one EMF log per group
        groupedMetrics.forEach((metricsRecordsGroupedByAttribute: Map<number, MetricRecord[]>, attrsKey: string) => {
          // metricRecords is grouped by attribute and timestamp
          metricsRecordsGroupedByAttribute.forEach((metricRecords: MetricRecord[], timestampMs: number) => {
            if (metricRecords) {
              diag.debug(
                `Creating EMF log for group with ${
                  metricRecords.length
                } metrics. Timestamp: ${timestampMs}, Attributes: ${attrsKey.substring(0, 100)}...`
              );

              // Create EMF log for this batch of metrics with the group's timestamp
              const emfLog = this.createEmfLog(metricRecords, resource, Number(timestampMs));

              // Convert to JSON
              const logEvent = {
                message: JSON.stringify(emfLog),
                timestamp: timestampMs,
              };

              // Send to CloudWatch Logs
              sendLogEventPromises.push(this.sendLogEvent(logEvent));
            }
          });
        });
        await Promise.all(sendLogEventPromises);
      }

      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (e) {
      diag.error(`Failed to export metrics: ${e}`);
      const exportResult: ExportResult = { code: ExportResultCode.FAILED };
      if (e instanceof Error) {
        exportResult.error = e;
      }
      resultCallback(exportResult);
    }
  }

  /**
   * Send a log event to CloudWatch Logs.
   *
   * This function implements the same logic as the Go version in the OTel Collector.
   * It batches log events according to CloudWatch Logs constraints and sends them
   * when the batch is full or spans more than 24 hours.
   *
   * @param logEvent The log event to send
   * @returns {Promise<void>}
   */
  private async sendLogEvent(logEvent: LogEvent) {
    // Prepare the PutLogEvents request
    const putLogEventsInput: PutLogEventsCommandInput = {
      logStreamName: this.logStreamName,
      logEvents: [logEvent],
      logGroupName: this.logGroupName,
    };

    try {
      if (!this.logStreamExists) {
        // Must perform logStreamExistsPromise check here because promises cannot be "awaited" in constructor.
        // Once the logStreamExistsPromise has resolved, this.logStreamExists will be true and this code block will be skipped.
        await this.logStreamExistsPromise;
      }

      // Make the PutLogEvents call
      await context.with(suppressTracing(context.active()), async () => {
        await this.logsClient.putLogEvents(putLogEventsInput);
      });

      diag.debug('Successfully sent log event');
    } catch (e) {
      diag.error(`Failed to send log events: ${e}`);
      throw e;
    }
  }

  /**
   * Force flush any pending metrics.
   */
  public async forceFlush() {
    diag.debug('AWSCloudWatchEMFExporter force flushes the bufferred metrics');
  }

  /**
   * Shutdown the exporter after force flush.
   *
   * @returns {Promise<void>}
   */
  public async shutdown() {
    await this.forceFlush();
    diag.debug('AWSCloudWatchEMFExporter shutdown called');
    return Promise.resolve();
  }

  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    return this.aggregationTemporality;
  }

  selectAggregation(instrumentType: InstrumentType): Aggregation {
    switch (instrumentType) {
      case InstrumentType.HISTOGRAM: {
        return Aggregation.ExponentialHistogram();
      }
    }
    return Aggregation.Default();
  }
}
