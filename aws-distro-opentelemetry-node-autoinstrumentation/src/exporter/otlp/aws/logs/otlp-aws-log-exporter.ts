// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPLogExporter as OTLPProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { CompressionAlgorithm, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { IExportLogsServiceResponse, ProtobufLogsSerializer } from '@opentelemetry/otlp-transformer';
import { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { OTLPAwsBaseExporter, OTLPAwsSigV4Options } from '../common/otlp-aws-base-exporter';

/**
 * This exporter extends the functionality of the OTLPProtoLogExporter to allow logs to be exported
 * to the CloudWatch Logs OTLP endpoint https://logs.[AWSRegion].amazonaws.com/v1/logs. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 * @param endpoint - The AWS CloudWatch Logs OTLP endpoint URL
 * @param config - Optional OTLP exporter configuration
 * @param sigV4Options - Optional signing service and region, overriding the defaults
 */
export class OTLPAwsLogExporter
  extends OTLPAwsBaseExporter<ReadableLogRecord[], IExportLogsServiceResponse>
  implements LogRecordExporter
{
  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase, sigV4Options?: OTLPAwsSigV4Options) {
    const modifiedConfig: OTLPExporterNodeConfigBase = {
      ...config,
      url: endpoint,
      compression: CompressionAlgorithm.NONE,
    };

    super(
      endpoint,
      sigV4Options?.service ?? 'logs',
      new OTLPProtoLogExporter(modifiedConfig),
      ProtobufLogsSerializer,
      config?.compression,
      sigV4Options?.region
    );
  }
}
