// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, diag, HrTime } from '@opentelemetry/api';
import {
  Aggregation,
  AggregationSelector,
  AggregationTemporality,
  AggregationTemporalitySelector,
  DataPoint,
  DataPointType,
  ExponentialHistogram,
  ExponentialHistogramMetricData,
  GaugeMetricData,
  Histogram,
  HistogramMetricData,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
  SumMetricData,
} from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { CloudWatchLogsClient } from './cloudwatch-logs-client';
import type { LogEvent, CloudWatchLogsClientConfig } from '@aws-sdk/client-cloudwatch-logs';

/**
 * Intermediate format for metric data before converting to EMF
 */
export interface MetricRecord {
  name: string;
  unit: string;
  description: string;
  timestamp: number;
  attributes: Attributes;

  // Only one of the following should be defined
  sumData?: number;
  histogramData?: HistogramMetricRecordData;
  expHistogramData?: ExponentialHistogramMetricRecordData;
  value?: number;
}

interface HistogramMetricRecordData {
  Count: number;
  Sum: number;
  Max: number;
  Min: number;
}

interface ExponentialHistogramMetricRecordData {
  Values: number[];
  Counts: number[];
  Count: number;
  Sum: number;
  Max: number;
  Min: number;
}

interface EMFLog {
  _aws: _Aws;
  [key: `otel.resource.${string}`]: string;
  [metricName: string]: any;
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

/**
 * OpenTelemetry metrics exporter for CloudWatch EMF format.
 *
 * This exporter converts OTel metrics into CloudWatch EMF logs which are then
 * sent to CloudWatch Logs. CloudWatch Logs automatically extracts the metrics
 * from the EMF logs.
 */
export class AWSCloudWatchEMFExporter implements PushMetricExporter {
  private namespace: string;
  private logClient: CloudWatchLogsClient;
  private aggregationTemporalitySelector: AggregationTemporalitySelector;
  private aggregationSelector: AggregationSelector;

  // CloudWatch EMF supported units
  // Ref: https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_MetricDatum.html
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
  // Ref: opentelemetry-collector-contrib/blob/main/exporter/awsemfexporter/grouped_metric.go#L188
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

  constructor(
    namespace: string = 'default',
    logGroupName: string,
    logStreamName?: string,
    aggregationTemporalitySelector?: AggregationTemporalitySelector,
    aggregationSelector?: AggregationSelector,
    cloudwatchLogsConfig: CloudWatchLogsClientConfig = {}
  ) {
    this.namespace = namespace;

    if (aggregationTemporalitySelector) {
      this.aggregationTemporalitySelector = aggregationTemporalitySelector;
    } else {
      this.aggregationTemporalitySelector = (instrumentType: InstrumentType) => {
        return AggregationTemporality.DELTA;
      };
    }

    if (aggregationSelector) {
      this.aggregationSelector = aggregationSelector;
    } else {
      this.aggregationSelector = (instrumentType: InstrumentType) => {
        switch (instrumentType) {
          case InstrumentType.HISTOGRAM: {
            return Aggregation.ExponentialHistogram();
          }
        }
        return Aggregation.Default();
      };
    }

    this.logClient = new CloudWatchLogsClient(logGroupName, logStreamName, cloudwatchLogsConfig);
  }

  /**
   * Get CloudWatch unit from unit in MetricRecord
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
   */
  private getDimensionNames(attributes: Attributes): string[] {
    return Object.keys(attributes);
  }

  /**
   * Create a hashable key from attributes for grouping metrics.
   */
  private getAttributesKey(attributes: Attributes): string {
    // Sort the attributes to ensure consistent keys
    const sortedAttrs = Object.entries(attributes).sort();
    // Create a string representation of the attributes
    return sortedAttrs.toString();
  }

  /**
   * Normalize an OpenTelemetry timestamp to milliseconds for CloudWatch.
   */
  private normalizeTimestamp(hrTime: HrTime): number {
    // Convert from second and nanoseconds to milliseconds
    const secondsToMillis = hrTime[0] * 1000;
    const nanosToMillis = Math.floor(hrTime[1] / 1_000_000);
    return secondsToMillis + nanosToMillis;
  }

  /**
   * Create a base metric record with instrument information.
   */
  private createMetricRecord(
    metricName: string,
    metricUnit: string,
    metricDescription: string,
    timestamp: number,
    attributes: Attributes
  ): MetricRecord {
    return {
      name: metricName,
      unit: metricUnit,
      description: metricDescription,
      timestamp,
      attributes,
    };
  }

  /**
   * Convert a Gauge or Sum metric datapoint to a metric record.
   */
  private convertGaugeAndSum(metric: SumMetricData | GaugeMetricData, dataPoint: DataPoint<number>): MetricRecord {
    const timestampMs = this.normalizeTimestamp(dataPoint.endTime);
    const record = this.createMetricRecord(
      metric.descriptor.name,
      metric.descriptor.unit,
      metric.descriptor.description,
      timestampMs,
      dataPoint.attributes
    );
    record.value = dataPoint.value;
    return record;
  }

  /**
   * Convert a Histogram metric datapoint to a metric record.
   *
   * https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/awsemfexporter/datapoint.go#L87
   */
  private convertHistogram(metric: HistogramMetricData, dataPoint: DataPoint<Histogram>): MetricRecord {
    const timestampMs = this.normalizeTimestamp(dataPoint.endTime);
    const record = this.createMetricRecord(
      metric.descriptor.name,
      metric.descriptor.unit,
      metric.descriptor.description,
      timestampMs,
      dataPoint.attributes
    );
    record.histogramData = {
      Count: dataPoint.value.count,
      Sum: dataPoint.value.sum ?? 0,
      Min: dataPoint.value.min ?? 0,
      Max: dataPoint.value.max ?? 0,
    };
    return record;
  }

  /**
   * Convert an ExponentialHistogram metric datapoint to a metric record.
   *
   * This function follows the logic of CalculateDeltaDatapoints in the Go implementation,
   * converting exponential buckets to their midpoint values.
   * Ref: https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/22626
   */
  private convertExpHistogram(
    metric: ExponentialHistogramMetricData,
    dataPoint: DataPoint<ExponentialHistogram>
  ): MetricRecord {
    // Initialize arrays for values and counts
    const arrayValues = [];
    const arrayCounts = [];

    const scale = dataPoint.value.scale;
    const base = Math.pow(2, Math.pow(2, -scale));

    // Process positive buckets
    if (dataPoint.value?.positive?.bucketCounts) {
      const positiveOffset = dataPoint.value.positive.offset;
      const positiveBucketCounts = dataPoint.value.positive.bucketCounts;

      let bucketBegin = 0;
      let bucketEnd = 0;

      for (const [i, count] of positiveBucketCounts.entries()) {
        const index = i + positiveOffset;

        if (bucketBegin === 0) {
          bucketBegin = Math.pow(base, index);
        } else {
          bucketBegin = bucketEnd;
        }

        bucketEnd = Math.pow(base, index + 1);
        // Calculate midpoint value of the bucket
        const metricVal = (bucketBegin + bucketEnd) / 2;

        // Only include buckets with positive counts
        if (count > 0) {
          arrayValues.push(metricVal);
          arrayCounts.push(count);
        }
      }
    }

    // Process zero bucket
    const zeroCount = dataPoint.value.zeroCount;
    if (zeroCount > 0) {
      arrayValues.push(0);
      arrayCounts.push(zeroCount);
    }

    // Process negative buckets
    if (dataPoint.value?.negative?.bucketCounts) {
      const negativeOffset = dataPoint.value.negative.offset;
      const negativeBucketCounts = dataPoint.value.negative.bucketCounts;

      let bucketBegin = 0;
      let bucketEnd = 0;

      for (const [i, count] of negativeBucketCounts.entries()) {
        const index = i + negativeOffset;

        if (bucketEnd === 0) {
          bucketEnd = -Math.pow(base, index);
        } else {
          bucketEnd = bucketBegin;
        }

        bucketBegin = -Math.pow(base, index + 1);
        // Calculate midpoint value of the bucket
        const metricVal = (bucketBegin + bucketEnd) / 2;

        // Only include buckets with positive counts
        if (count > 0) {
          arrayValues.push(metricVal);
          arrayCounts.push(count);
        }
      }
    }

    const timestampMs = this.normalizeTimestamp(dataPoint.endTime);
    const record = this.createMetricRecord(
      metric.descriptor.name,
      metric.descriptor.unit,
      metric.descriptor.description,
      timestampMs,
      dataPoint.attributes
    );

    // Set the histogram data in the format expected by CloudWatch EMF
    record.expHistogramData = {
      Values: arrayValues,
      Counts: arrayCounts,
      Count: dataPoint.value.count,
      Sum: dataPoint.value.sum ?? 0,
      Max: dataPoint.value.max ?? 0,
      Min: dataPoint.value.min ?? 0,
    };

    return record;
  }

  /**
   * Create EMF log from metric records.
   *
   * Since metricRecords is already grouped by attributes, this function
   * creates a single EMF log for all records.
   */
  private createEmfLog(
    metricRecords: MetricRecord[],
    resource: Resource,
    timestamp: number | undefined = undefined
  ): EMFLog {
    // Start with base structure and latest EMF version schema
    // opentelemetry-collector-contrib/blob/main/exporter/awsemfexporter/metric_translator.go#L414
    const emfLog: EMFLog = {
      _aws: {
        Timestamp: timestamp || Date.now(),
        CloudWatchMetrics: [],
      },
      Version: '1',
    };

    // Add resource attributes to EMF log but not as dimensions
    // OTel collector EMF Exporter has a resource_to_telemetry_conversion flag that will convert resource attributes
    // as regular metric attributes(potential dimensions). However, for this SDK EMF implementation,
    // we align with the OpenTelemetry concept that all metric attributes are treated as dimensions.
    // And have resource attributes as just additional metadata in EMF, added otel.resource as prefix to distinguish.
    if (resource && resource.attributes) {
      for (const [key, value] of Object.entries(resource.attributes)) {
        emfLog[`otel.resource.${key}`] = value?.toString() ?? 'undefined';
      }
    }

    // Initialize collections for dimensions and metrics
    const metricDefinitions: Metric[] = [];
    // Collect attributes from all records (they should be the same for all records in the group)
    // Only collect once from the first record and apply to all records
    const allAttributes: Attributes = metricRecords.length > 0 ? metricRecords[0].attributes : {};

    // Process each metric record
    for (const record of metricRecords) {
      const metricName = record.name;
      if (!metricName) {
        continue;
      }

      if (record.expHistogramData) {
        // Base2 Exponential Histogram
        emfLog[metricName] = record.expHistogramData;
      } else if (record.histogramData) {
        // Regular Histogram metrics
        emfLog[metricName] = record.histogramData;
      } else if (record.value !== undefined) {
        // Gauge, Sum, and other aggregations
        emfLog[metricName] = record.value;
      } else {
        diag.debug(`Skipping metric ${metricName} as it does not have valid metric value`);
        continue;
      }

      const metricData: Metric = {
        Name: metricName,
      };

      const unit = this.getUnit(record);
      if (unit) {
        metricData.Unit = unit;
      }
      metricDefinitions.push(metricData);
    }

    const dimensionNames = this.getDimensionNames(allAttributes);

    for (const [name, value] of Object.entries(allAttributes)) {
      emfLog[name] = value?.toString() ?? 'undefined';
    }

    if (dimensionNames && metricDefinitions.length > 0) {
      emfLog._aws.CloudWatchMetrics.push({
        Namespace: this.namespace,
        Dimensions: [dimensionNames],
        Metrics: metricDefinitions,
      });
    }

    return emfLog;
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
      // The resource is now part of each resourceMetrics object
      const resource = resourceMetrics.resource;

      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        // Map of maps to group metrics by attributes and timestamp
        // Keys: (attributesKey, timestampMs)
        // Value: list of metric records
        const groupedMetrics = new Map<string, Map<number, MetricRecord[]>>();

        // Process all metrics in this scope
        for (const metric of scopeMetrics.metrics) {
          // Convert metrics to a format compatible with createEmfLog
          // Process metric.dataPoints for different metric types
          if (metric.dataPointType === DataPointType.GAUGE || metric.dataPointType === DataPointType.SUM) {
            for (const dataPoint of metric.dataPoints) {
              const record = this.convertGaugeAndSum(metric, dataPoint);
              const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record);
              this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
            }
          } else if (metric.dataPointType === DataPointType.HISTOGRAM) {
            for (const dataPoint of metric.dataPoints) {
              const record = this.convertHistogram(metric, dataPoint);
              const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record);
              this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
            }
          } else if (metric.dataPointType === DataPointType.EXPONENTIAL_HISTOGRAM) {
            for (const dataPoint of metric.dataPoints) {
              const record = this.convertExpHistogram(metric, dataPoint);
              const [groupAttribute, groupTimestamp] = this.groupByAttributesAndTimestamp(record);
              this.pushMetricRecordIntoGroupedMetrics(groupedMetrics, groupAttribute, groupTimestamp, record);
            }
          } else {
            // This else block should never run, all metric types are accounted for above
            diag.debug(`Unsupported Metric Type in metric: ${metric}`);
          }
        }

        // Now process each group separately to create one EMF log per group
        for (const [_, metricsRecordsGroupedByTimestamp] of groupedMetrics) {
          for (const [timestampMs, metricRecords] of metricsRecordsGroupedByTimestamp) {
            if (metricRecords) {
              // Create and send EMF log for this batch of metrics

              // Convert to JSON
              const logEvent = {
                message: JSON.stringify(this.createEmfLog(metricRecords, resource, Number(timestampMs))),
                timestamp: timestampMs,
              };

              // Send to CloudWatch Logs
              await this.sendLogEvent(logEvent);
            }
          }
        }
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
   * Send a log event to CloudWatch Logs using the log client.
   *
   * @param logEvent The log event to send
   * @returns {Promise<void>}
   */
  private async sendLogEvent(logEvent: Required<LogEvent>) {
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

  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    return this.aggregationTemporalitySelector(instrumentType);
  }

  selectAggregation(instrumentType: InstrumentType): Aggregation {
    return this.aggregationSelector(instrumentType);
  }
}
