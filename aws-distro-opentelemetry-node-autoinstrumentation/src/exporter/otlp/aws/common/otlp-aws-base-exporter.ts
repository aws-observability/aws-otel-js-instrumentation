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

  // Serializes exports so that only one is in flight at a time.
  //
  // An export stores its serialized body on the shared serializer and its signed headers on the
  // shared transport, and those are read back later - the body when the upstream export is invoked,
  // the headers when the transport sends. Overlapping exports therefore clobber each other: a
  // request can go out with another batch's body (silently losing a batch and duplicating another),
  // or with a body and a signature that disagree, which the endpoint rejects as a signature
  // mismatch.
  //
  // Exports overlap whenever a batch processor flushes, because BatchSpanProcessorBase._flushAll()
  // exports every queued batch in parallel. Steady-state exports are already serialized by the
  // processor's own in-flight guard.
  private exportQueue: Promise<void> = Promise.resolve();

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
   *
   * Exports are queued so that each one completes before the next begins, because the signing step
   * keeps per-request state on objects shared across exports. See {@link exportQueue}.
   *
   * @param items - Array of signal data to export
   * @param resultCallback - Callback function to handle export result
   */
  override export(items: Payload, resultCallback: (result: ExportResult) => void): Promise<void> {
    const previousExport = this.exportQueue;

    // Released once this export has produced a result, which is what lets the next one start.
    let releaseQueue!: () => void;
    const thisExportSettled = new Promise<void>(resolve => (releaseQueue = resolve));

    // `previousExport` never rejects (see below), so the chain cannot be broken by a failed export.
    this.exportQueue = previousExport.then(() => thisExportSettled);

    return previousExport.then(() => {
      let settled = false;

      const settle = (result: ExportResult) => {
        // Upstream invokes the callback exactly once on every branch, including its rejection
        // handler. Guard anyway: releasing twice is harmless, but never releasing would wedge the
        // queue permanently, which would be worse than the defect this fixes.
        if (settled) {
          return;
        }
        settled = true;
        releaseQueue();
        resultCallback(result);
      };

      // Catch rather than propagate, so an unexpected throw still releases the queue and is
      // reported through the callback like every other failure.
      return this.doExport(items, settle).catch(error => {
        settle({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    });
  }

  private async doExport(items: Payload, resultCallback: (result: ExportResult) => void): Promise<void> {
    // In OTel 2.x, headers() is an async function that returns a Promise
    const headersGetter = this.parentExporter['_delegate']._transport?._transport?._parameters?.headers;

    if (!headersGetter) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error(`Request headers are unset - unable to export to ${this.endpoint}`),
      });
      return;
    }

    const headers = await headersGetter();

    if (!headers) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error(`Headers returned undefined - unable to export to ${this.endpoint}`),
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

    // OTel 2.x expects an async headers function
    this.parentExporter['_delegate']._transport._transport._parameters.headers = async () => signedHeaders;
    this.parentExporter.export(items, resultCallback);
  }

  override async shutdown(): Promise<void> {
    // Let queued exports finish before tearing the parent down, so they are not abandoned.
    await this.exportQueue;
    return this.parentExporter.shutdown();
  }

  override async forceFlush(): Promise<void> {
    // A flush must not report completion while exports are still waiting their turn.
    await this.exportQueue;
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
