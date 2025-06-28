// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CompressionAlgorithm, OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import { gzipSync } from 'zlib';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { AwsAuthenticator } from './aws-authenticator';
import { ISerializer } from '@opentelemetry/otlp-transformer';

/**
 * Base class for AWS OTLP exporters
 */
export abstract class OTLPAwsBaseExporter<Payload, Response> extends OTLPExporterBase<Payload> {
  protected parentExporter: OTLPExporterBase<Payload>;
  private readonly compression?: CompressionAlgorithm;
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
    super(parentExporter['_delegate']);
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
  override async export(items: Payload, resultCallback: (result: ExportResult) => void): Promise<void> {
    const headers = this.parentExporter['_delegate']._transport?._transport?._parameters?.headers();

    if (!headers) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error(`Request headers are unset - unable to export to ${this.endpoint}`),
      });
      return;
    }

    let serializedData: Uint8Array | undefined = this.parentSerializer.serializeRequest(items);

    if (!serializedData) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Nothing to send'),
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
    const signedHeaders = await this.authenticator.authenticate(headers, serializedData);

    if (!signedHeaders) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Sigv4 Signing Failed. Not exporting'),
      });
      return;
    }

    this.parentExporter['_delegate']._transport._transport._parameters.headers = () => signedHeaders;
    this.parentExporter.export(items, resultCallback);
  }

  override shutdown(): Promise<void> {
    return this.parentExporter.shutdown();
  }

  override forceFlush(): Promise<void> {
    return this.parentExporter.forceFlush();
  }
}

/**
 * A serializer that bypasses request serialization by returning pre-serialized data.
 * @template Response The type of the deserialized response
 */
class PassthroughSerializer<Response> implements ISerializer<Uint8Array, Response> {
  private serializedData: Uint8Array = new Uint8Array();
  private deserializer: (data: Uint8Array) => Response;

  /**
   * Creates a new PassthroughSerializer instance.
   * @param deserializer Function to deserialize response data
   */
  constructor(deserializer: (data: Uint8Array) => Response) {
    this.deserializer = deserializer;
  }

  /**
   * Sets the pre-serialized data to be returned when serializeRequest is called.
   * @param data The serialized data to use
   */
  setSerializedData(data: Uint8Array): void {
    this.serializedData = data;
  }

  /**
   * Returns the pre-serialized data, ignoring the request parameter.
   * @param request Ignored parameter.
   * @returns The pre-serialized data
   */
  serializeRequest(request: Uint8Array): Uint8Array {
    return this.serializedData;
  }

  /**
   * Deserializes response data using the provided deserializer function.
   * @param data The response data to deserialize
   * @returns The deserialized response
   */
  deserializeResponse(data: Uint8Array): Response {
    return this.deserializer(data);
  }
}
