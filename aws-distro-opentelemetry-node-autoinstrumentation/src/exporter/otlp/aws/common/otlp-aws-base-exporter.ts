// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CompressionAlgorithm, OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import { gzipSync } from 'zlib';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { AwsAuthenticator } from './aws-authenticator';
import { PassthroughSerializer } from './passthrough-serializer';
import { ISerializer } from '@opentelemetry/otlp-transformer';

/**
 * Base class for AWS OTLP exporters
 */
export abstract class OTLPAwsBaseExporter<Payload, Response> {
  protected parentExporter: OTLPExporterBase<Payload>;
  private compression?: CompressionAlgorithm;
  private endpoint: string;
  private serializer: PassthroughSerializer<Response>;
  private authenticator: AwsAuthenticator;
  private parentSerializer: ISerializer<Payload, Response>;

  constructor(
    endpoint: string,
    service: string,
    parentExporter: OTLPExporterBase<Payload>,
    parentSerializer: ISerializer<Payload, Response>,
    compression?: CompressionAlgorithm
  ) {
    this.compression = compression;
    this.endpoint = endpoint;
    this.authenticator = new AwsAuthenticator(this.endpoint, service);
    this.parentExporter = parentExporter;
    this.parentSerializer = parentSerializer;

    // To prevent performance degradation from serializing and compressing data twice, we handle serialization and compression
    // locally in this exporter and pass the pre-processed data to the upstream export.
    // This is used in order to prevent serializing and compressing the data again when calling parentExporter.export().
    // To see why this works:
    // https://github.com/open-telemetry/opentelemetry-js/blob/ec17ce48d0e5a99a122da5add612a20e2dd84ed5/experimental/packages/otlp-exporter-base/src/otlp-export-delegate.ts#L69
    this.serializer = new PassthroughSerializer<Response>(this.parentSerializer.deserializeResponse);

    this.parentExporter['_delegate']._serializer = this.serializer;
  }

  /**
   * Overrides the upstream implementation of export.
   * All behaviors are the same except if the endpoint is an AWS OTLP endpoint, we will sign the request with SigV4
   * in headers before sending it to the endpoint.
   * @param items - Array of signal data to export
   * @param resultCallback - Callback function to handle export result
   */
  public async export(items: Payload, resultCallback: (result: ExportResult) => void): Promise<void> {
    let serializedData: Uint8Array | undefined = this.parentSerializer.serializeRequest(items);

    if (!serializedData) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Nothing to send'),
      });
      return;
    }

    const headers = this.parentExporter['_delegate']._transport?._transport?._parameters?.headers();

    // This should never be reached as upstream always sets the header.
    if (!headers) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error(`Request headers are undefined - unable to export to ${this.endpoint}`),
      });

      return;
    }

    delete headers['Content-Encoding'];
    const shouldCompress = this.compression && this.compression !== CompressionAlgorithm.NONE;

    if (shouldCompress) {
      try {
        serializedData = gzipSync(serializedData);
        headers['Content-Encoding'] = 'gzip';
      } catch (exception) {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error(`Failed to compress: ${exception}`),
        });
        return;
      }
    }

    this.serializer.setSerializedData(serializedData);

    const signedRequestHeaders = await this.authenticator.authenticate(headers, serializedData);

    if (signedRequestHeaders) {
      this.parentExporter['_delegate']._transport._transport._parameters.headers = () => signedRequestHeaders;
    }

    this.parentExporter.export(items, resultCallback);
  }
}
