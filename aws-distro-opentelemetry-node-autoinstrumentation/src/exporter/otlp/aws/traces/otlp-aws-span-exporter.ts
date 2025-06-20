// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { CompressionAlgorithm, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { IExportTraceServiceResponse, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { AwsAuthenticator } from '../common/aws-authenticator';
import { PassthroughSerializer } from '../common/passthrough-serializer';
import { gzipSync } from 'zlib';

/**
 * This exporter extends the functionality of the OTLPProtoTraceExporter to allow spans to be exported
 * to the XRay OTLP endpoint https://xray.[AWSRegion].amazonaws.com/v1/traces. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 */
export class OTLPAwsSpanExporter extends OTLPProtoTraceExporter {
  private compression: CompressionAlgorithm | undefined;
  private endpoint: string;
  private region: string;
  private serializer: PassthroughSerializer<IExportTraceServiceResponse>;
  private authenticator: AwsAuthenticator;

  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase) {
    const modifiedConfig: OTLPExporterNodeConfigBase = {
      ...config,
      url: endpoint,
      compression: CompressionAlgorithm.NONE,
    };

    super(modifiedConfig);
    this.region = endpoint.split('.')[1];
    this.endpoint = endpoint;
    this.authenticator = new AwsAuthenticator(this.region, 'xray');
    this.serializer = new PassthroughSerializer(ProtobufTraceSerializer.deserializeResponse);
    this['_delegate']._serializer = this.serializer;
  }

  /**
   * Overrides the upstream implementation of export. All behaviors are the same except if the
   * endpoint is an XRay OTLP endpoint, we will sign the request with SigV4 in headers before
   * sending it to the endpoint. Otherwise, we will skip signing.
   * To prevent performance degradation from serializing and compressing data twice, we handle serialization and compression
   * locally in this exporter and pass the pre-processed data to the upstream export functionality.
   */
  public override async export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): Promise<void> {
    let serializedSpans: Uint8Array | undefined = ProtobufTraceSerializer.serializeRequest(items);

    if (serializedSpans === undefined) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Nothing to send'),
      });
      return;
    }

    // Pass pre-processed data to passthrough serializer. When super.export() is called, the Passthrough Serializer will
    // use the pre-processed data instead of serializing and compressing the data again.
    const shouldCompress = this.compression && this.compression !== CompressionAlgorithm.NONE;
    if (shouldCompress) {
      serializedSpans = gzipSync(serializedSpans);
    }

    this.serializer.setSerializedData(serializedSpans);

    const headers = this['_delegate']._transport?._transport?._parameters?.headers();

    if (headers) {
      if (shouldCompress) {
        headers['Content-Encoding'] = 'gzip';
      } else {
        delete headers['Content-Encoding'];
      }

      const signedRequest = await this.authenticator.authenticate(this.endpoint, headers, serializedSpans);

      // See type: https://github.com/open-telemetry/opentelemetry-js/blob/experimental/v0.57.1/experimental/packages/otlp-exporter-base/src/transport/http-transport-types.ts#L31
      const newHeaders: () => Record<string, string> = () => signedRequest;
      this['_delegate']._transport._transport._parameters.headers = newHeaders;
    }

    super.export(items, resultCallback);
  }
}
