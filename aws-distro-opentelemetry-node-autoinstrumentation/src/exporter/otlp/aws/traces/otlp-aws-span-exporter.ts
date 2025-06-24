// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { CompressionAlgorithm, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { IExportTraceServiceResponse, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPAwsBaseExporter } from '../common/otlp-aws-base-exporter';

/**
 * This exporter extends the functionality of the OTLPProtoTraceExporter to allow spans to be exported
 * to the XRay OTLP endpoint https://xray.[AWSRegion].amazonaws.com/v1/traces. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 *
 * @param endpoint - The AWS X-Ray OTLP endpoint URL
 * @param config - Optional OTLP exporter configuration
 */
export class OTLPAwsSpanExporter
  extends OTLPAwsBaseExporter<ReadableSpan[], IExportTraceServiceResponse>
  implements SpanExporter
{
  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase) {
    const modifiedConfig: OTLPExporterNodeConfigBase = {
      ...config,
      url: endpoint,
      compression: CompressionAlgorithm.NONE,
    };

    super(endpoint, 'xray', new OTLPProtoTraceExporter(modifiedConfig), ProtobufTraceSerializer, config?.compression);
  }
}
