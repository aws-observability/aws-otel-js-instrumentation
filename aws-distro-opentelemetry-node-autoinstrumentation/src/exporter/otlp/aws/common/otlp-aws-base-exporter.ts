// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CompressionAlgorithm, OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import { gzipSync } from 'zlib';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { AwsAuthenticator } from './aws-authenticator';
import { PassthroughSerializer } from './passthrough-serializer';
import { ISerializer } from '@opentelemetry/otlp-transformer';
import { diag } from '@opentelemetry/api';

/**
 * Base class for AWS OTLP exporters
 */
export abstract class OTLPAwsBaseExporter<Payload, Response> {
  protected parentExporter: OTLPExporterBase<Payload>;
  private readonly originalHeaders?: Record<string, string>;
  private readonly compression?: CompressionAlgorithm;
  private newHeaders: Record<string, string> = {};
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
    this.originalHeaders = this.getHeaders();
  }

  /**
   * Overrides the upstream implementation of export.
   * All behaviors are the same except if the endpoint is an AWS OTLP endpoint, we will sign the request with SigV4
   * in headers before sending it to the endpoint.
   * @param items - Array of signal data to export
   * @param resultCallback - Callback function to handle export result
   */
  public async export(items: Payload, resultCallback: (result: ExportResult) => void): Promise<void> {
    if (this.originalHeaders) {
      let serializedData: Uint8Array | undefined = this.parentSerializer.serializeRequest(items);

      if (!serializedData) {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error('Nothing to send'),
        });
        return;
      }

      const shouldCompress = this.compression && this.compression !== CompressionAlgorithm.NONE;

      if (shouldCompress) {
        try {
          serializedData = gzipSync(serializedData);
          this.addHeader('Content-Encoding', 'gzip');
        } catch (exception) {
          resultCallback({
            code: ExportResultCode.FAILED,
            error: new Error(`Failed to compress: ${exception}`),
          });
          return;
        }
      }

      this.serializer.setSerializedData(serializedData);

      const mergedHeaders = { ...this.newHeaders, ...this.originalHeaders };
      const signedHeaders = await this.authenticator.authenticate(mergedHeaders, serializedData);

      if (signedHeaders) {
        this.setTransportHeaders(signedHeaders);
      }

      this.parentExporter.export(items, resultCallback);

      this.setTransportHeaders(this.originalHeaders);
      this.newHeaders = {};
      return;
    }

    resultCallback({
      code: ExportResultCode.FAILED,
      error: new Error('No headers found, cannot sign request. Not exporting.'),
    });
  }

  // This is a bit ugly but need it in order safely set any new headers

  /**
   * Adds a header to the exporter's transport parameters
   */
  protected addHeader(key: string, value: string): void {
    this.newHeaders[key] = value;
  }

  /**
   * Gets headers in the transport parameters
   */
  private getHeaders(): Record<string, string> | undefined {
    const headersFunc = this.parentExporter['_delegate']._transport?._transport?._parameters?.headers;
    if (!headersFunc) {
      diag.debug('No existing headers found, using empty headers.');
      return undefined;
    }
    return headersFunc();
  }

  /**
   * Sets headers in the transport parameters
   */
  private setTransportHeaders(headers: Record<string, string>): void {
    const parameters = this.parentExporter['_delegate']._transport?._transport?._parameters;
    if (parameters) {
      parameters.headers = () => headers;
    }
  }
}
