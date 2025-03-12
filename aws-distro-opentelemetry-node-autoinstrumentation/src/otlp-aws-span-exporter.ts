// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { diag } from '@opentelemetry/api';
import { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResult } from '@opentelemetry/core';
import { getNodeVersion } from './utils';

/**
 * This exporter extends the functionality of the OTLPProtoTraceExporter to allow spans to be exported
 * to the XRay OTLP endpoint https://xray.[AWSRegion].amazonaws.com/v1/traces. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 */
export class OTLPAwsSpanExporter extends OTLPProtoTraceExporter {
  private static readonly SERVICE_NAME: string = 'xray';
  private endpoint: string;
  private region: string;

  // Holds the dependencies needed to sign the SigV4 headers
  private defaultProvider: any;
  private sha256: any;
  private signatureV4: any;
  private httpRequest: any;

  // If the required dependencies are installed then we enable SigV4 signing. Otherwise skip it
  private hasRequiredDependencies: boolean = false;

  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase) {
    super(OTLPAwsSpanExporter.changeUrlConfig(endpoint, config));
    this.initDependencies();
    this.region = endpoint.split('.')[1];
    this.endpoint = endpoint;
  }

  /**
   * Overrides the upstream implementation of export. All behaviors are the same except if the
   * endpoint is an XRay OTLP endpoint, we will sign the request with SigV4 in headers before
   * sending it to the endpoint. Otherwise, we will skip signing.
   */
  public override async export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): Promise<void> {
    // Only do SigV4 Signing if the required dependencies are installed. Otherwise default to the regular http/protobuf exporter.
    if (this.hasRequiredDependencies) {
      const url = new URL(this.endpoint);
      const serializedSpans: Uint8Array | undefined = ProtobufTraceSerializer.serializeRequest(items);

      if (serializedSpans === undefined) {
        return;
      }

      /*
        This is bad practice but there is no other way to access and inject SigV4 headers
        into the request headers before the traces get exported.
      */
      const oldHeaders = (this as any)._delegate._transport?._transport?._parameters?.headers;

      if (oldHeaders) {
        const request = new this.httpRequest({
          method: 'POST',
          protocol: 'https',
          hostname: url.hostname,
          path: url.pathname,
          body: serializedSpans,
          headers: {
            ...this.removeSigV4Headers(oldHeaders),
            host: url.hostname,
          },
        });

        try {
          const signer = new this.signatureV4({
            credentials: this.defaultProvider(),
            region: this.region,
            service: OTLPAwsSpanExporter.SERVICE_NAME,
            sha256: this.sha256,
          });

          const signedRequest = await signer.sign(request);

          (this as any)._delegate._transport._transport._parameters.headers = signedRequest.headers;
        } catch (exception) {
          diag.debug(
            `Failed to sign/authenticate the given exported Span request to OTLP XRay endpoint with error: ${exception}`
          );
        }
      }
    }

    await super.export(items, resultCallback);
  }

  // Removes Sigv4 headers from old headers to avoid accidentally copying them to the new headers
  private removeSigV4Headers(headers: Record<string, string>) {
    const newHeaders: Record<string, string> = {};
    const sigV4Headers = ['x-amz-date', 'authorization', 'x-amz-content-sha256', 'x-amz-security-token'];

    for (const key in headers) {
      if (!sigV4Headers.includes(key.toLowerCase())) {
        newHeaders[key] = headers[key];
      }
    }
    return newHeaders;
  }

  private initDependencies(): any {
    if (getNodeVersion() < 16) {
      diag.error('SigV4 signing requires atleast Node major version 16');
      return;
    }

    try {
      const awsSdkModule = require('@aws-sdk/credential-provider-node');
      const awsCryptoModule = require('@aws-crypto/sha256-js');
      const signatureModule = require('@smithy/signature-v4');
      const httpModule = require('@smithy/protocol-http');

      (this.defaultProvider = awsSdkModule.defaultProvider),
        (this.sha256 = awsCryptoModule.Sha256),
        (this.signatureV4 = signatureModule.SignatureV4),
        (this.httpRequest = httpModule.HttpRequest);
      this.hasRequiredDependencies = true;
    } catch (error) {
      diag.error(`Failed to load required AWS dependency for SigV4 Signing: ${error}`);
    }
  }

  private static changeUrlConfig(endpoint: string, config?: OTLPExporterNodeConfigBase): OTLPExporterNodeConfigBase {
    const newConfig =
      config == null
        ? { url: endpoint }
        : {
            ...config,
            url: endpoint,
          };

    return newConfig;
  }
}
