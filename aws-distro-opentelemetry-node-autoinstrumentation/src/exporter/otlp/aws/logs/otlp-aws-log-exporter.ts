// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPLogExporter as OTLPProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { CompressionAlgorithm, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { gzipSync } from 'zlib';
import { IExportLogsServiceResponse, ProtobufLogsSerializer } from '@opentelemetry/otlp-transformer';
import { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { AwsAuthenticator } from '../common/aws-authenticator';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { PassthroughSerializer } from '../common/passthrough-serializer';

/**
 * This exporter extends the functionality of the OTLPProtoLogExporter to allow spans to be exported
 * to the CloudWatch Logs OTLP endpoint https://logs.[AWSRegion].amazonaws.com/v1/logs. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 */

export class OTLPAwsLogExporter extends OTLPProtoLogExporter {
  private compression: CompressionAlgorithm | undefined;
  private endpoint: string;
  private region: string;
  private serializer: PassthroughSerializer<IExportLogsServiceResponse>;
  private authenticator: AwsAuthenticator;

  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase) {
    const modifiedConfig: OTLPExporterNodeConfigBase = {
      ...config,
      url: endpoint,
      compression: CompressionAlgorithm.NONE,
    };

    super(modifiedConfig);
    this.compression = config?.compression;
    this.region = endpoint.split('.')[1];
    this.endpoint = endpoint;
    this.authenticator = new AwsAuthenticator(this.region, 'logs');

    // This is used in order to prevent serializing and compressing the data twice. Once for signing Sigv4 and
    // once when we pass the data to super.export() which will serialize and compress the data again.
    this.serializer = new PassthroughSerializer(ProtobufLogsSerializer.deserializeResponse);
    this['_delegate']._serializer = this.serializer;
  }

  /**
   * Overrides the upstream implementation of export. If the
   * endpoint is the CloudWatch Logs OTLP endpoint, we sign the request with SigV4 in headers.
   * To prevent performance degradation from serializing and compressing data twice, we handle serialization and compression
   * locally in this exporter and pass the pre-processed data to the upstream export functionality.
   */

  // Upstream already implements a retry mechanism:
  // https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/otlp-exporter-base/src/retrying-transport.ts

  public override async export(
    items: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void
  ): Promise<void> {
    let serializedLogs: Uint8Array | undefined = ProtobufLogsSerializer.serializeRequest(items);

    if (serializedLogs === undefined) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Nothing to send'),
      });
      return;
    }

    const shouldCompress = this.compression && this.compression !== CompressionAlgorithm.NONE;
    if (shouldCompress) {
      serializedLogs = gzipSync(serializedLogs);
    }

    // Pass pre-processed data to passthrough serializer. When super.export() is called, the Passthrough Serializer will
    // use the pre-processed data instead of serializing and compressing the data again.
    this.serializer.setSerializedData(serializedLogs);

    // See type: https://github.com/open-telemetry/opentelemetry-js/blob/experimental/v0.57.1/experimental/packages/otlp-exporter-base/src/transport/http-transport-types.ts#L31
    const headers = this['_delegate']._transport?._transport?._parameters?.headers();

    if (headers) {
      if (shouldCompress) {
        headers['Content-Encoding'] = 'gzip';
      } else {
        delete headers['Content-Encoding'];
      }

      const signedRequest = await this.authenticator.authenticate(this.endpoint, headers, serializedLogs);

      const newHeaders: () => Record<string, string> = () => signedRequest;
      this['_delegate']._transport._transport._parameters.headers = newHeaders;
    }

    super.export(items, resultCallback);
  }
}
