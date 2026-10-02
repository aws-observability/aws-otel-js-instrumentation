// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPMetricExporter as OTLPProtoMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { CompressionAlgorithm, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { IExportMetricsServiceResponse, ProtobufMetricsSerializer } from '@opentelemetry/otlp-transformer';
import {
  AggregationOption,
  AggregationTemporality,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { ExportResult } from '@opentelemetry/core';
import { OTLPAwsBaseExporter } from '../common/otlp-aws-base-exporter';

/**
 * This exporter extends the functionality of the OTLPProtoMetricExporter to allow metrics to be
 * exported to the CloudWatch OTLP endpoint https://monitoring.[AWSRegion].amazonaws.com/v1/metrics.
 * Utilizes the aws-sdk library to sign and directly inject SigV4 Authentication to the exported
 * request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 *
 * @param endpoint - The CloudWatch metrics OTLP endpoint URL
 * @param config - Optional OTLP exporter configuration
 */
export class OTLPAwsMetricExporter
  extends OTLPAwsBaseExporter<ResourceMetrics, IExportMetricsServiceResponse>
  implements PushMetricExporter
{
  private metricParentExporter: OTLPProtoMetricExporter;

  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase) {
    const modifiedConfig: OTLPExporterNodeConfigBase = {
      ...config,
      url: endpoint,
      compression: CompressionAlgorithm.NONE,
    };

    const parentExporter = new OTLPProtoMetricExporter(modifiedConfig);

    super(endpoint, 'monitoring', parentExporter, ProtobufMetricsSerializer, config?.compression);

    this.metricParentExporter = parentExporter;
  }

  override async export(items: ResourceMetrics, resultCallback: (result: ExportResult) => void): Promise<void> {
    return super.export(items, resultCallback);
  }

  /**
   * Delegates the temporality preference to the wrapped exporter.
   *
   * This must not be omitted. `selectAggregationTemporality` is optional on PushMetricExporter, so a
   * wrapper that leaves it out still compiles, and PeriodicExportingMetricReader then silently falls
   * back to the default (cumulative) instead of honouring
   * OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE. That changes what the metric means rather
   * than producing an error.
   */
  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    return this.metricParentExporter.selectAggregationTemporality(instrumentType);
  }

  /**
   * Delegates the aggregation preference to the wrapped exporter, for the same reason as
   * {@link selectAggregationTemporality}.
   */
  selectAggregation(instrumentType: InstrumentType): AggregationOption {
    return this.metricParentExporter.selectAggregation(instrumentType);
  }
}
