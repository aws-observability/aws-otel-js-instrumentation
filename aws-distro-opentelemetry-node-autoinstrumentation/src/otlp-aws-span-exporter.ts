// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { diag } from '@opentelemetry/api';
import { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { ExportResult } from '@opentelemetry/core';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Sha256 } from '@aws-crypto/sha256-js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SignatureV4 } from '@smithy/signature-v4';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { HttpRequest } from '@smithy/protocol-http';

const SERVICE_NAME = 'xray';

/**
 * This exporter extends the functionality of the OTLPProtoTraceExporter to allow spans to be exported
 * to the XRay OTLP endpoint https://xray.[AWSRegion].amazonaws.com/v1/traces. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 */
export class OTLPAwsSpanExporter extends OTLPProtoTraceExporter {
  private endpoint: string;
  private region: string;

  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase) {
    super(config);
    this.region = endpoint.split('.')[1];
    this.endpoint = endpoint;
  }

  /**
   * Overrides the upstream implementation of export. All behaviors are the same except if the
   * endpoint is an XRay OTLP endpoint, we will sign the request with SigV4 in headers before
   * sending it to the endpoint. Otherwise, we will skip signing.
   */
  public override async export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): Promise<void> {
    const url = new URL(this.endpoint);
    const serializedSpans: Uint8Array | undefined = ProtobufTraceSerializer.serializeRequest(items);

    if (serializedSpans === undefined) {
      return;
    }

    /*
      This is bad practice but there is no other way to access and inject SigV4 headers
      into the request headers before the traces get exported.
    */
    const oldHeaders = (this as any)._transport._transport._parameters.headers;

    const request = new HttpRequest({
      method: 'POST',
      protocol: 'https',
      hostname: url.hostname,
      path: url.pathname,
      body: serializedSpans,
      headers: {
        ...oldHeaders,
        host: url.hostname,
      },
    });

    try {
      const signer = new SignatureV4({
        credentials: defaultProvider(),
        region: this.region,
        service: SERVICE_NAME,
        sha256: Sha256,
      });

      const signedRequest = await signer.sign(request);

      (this as any)._transport._transport._parameters.headers = signedRequest.headers;
    } catch (exception) {
      diag.debug(
        `Failed to sign/authenticate the given exported Span request to OTLP XRay endpoint with error: ${exception}`
      );
    }

    await super.export(items, resultCallback);
  }
}
