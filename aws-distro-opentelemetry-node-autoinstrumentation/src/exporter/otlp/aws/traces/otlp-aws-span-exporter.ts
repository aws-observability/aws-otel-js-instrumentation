// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResult } from '@opentelemetry/core';
import { AwsAuthenticator } from '../common/aws-authenticator';
import { changeUrlConfig } from '../common/utils';

/**
 * This exporter extends the functionality of the OTLPProtoTraceExporter to allow spans to be exported
 * to the XRay OTLP endpoint https://xray.[AWSRegion].amazonaws.com/v1/traces. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 */
export class OTLPAwsSpanExporter extends OTLPProtoTraceExporter {
  private endpoint: string;
  private region: string;
  private authenticator: AwsAuthenticator;

  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase) {
    super(changeUrlConfig(endpoint, config));
    this.region = endpoint.split('.')[1];
    this.endpoint = endpoint;
    this.authenticator = new AwsAuthenticator(this.region, 'xray');
  }

  /**
   * Overrides the upstream implementation of export. All behaviors are the same except if the
   * endpoint is an XRay OTLP endpoint, we will sign the request with SigV4 in headers before
   * sending it to the endpoint. Otherwise, we will skip signing.
   */
  public override async export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): Promise<void> {
    const serializedSpans: Uint8Array | undefined = ProtobufTraceSerializer.serializeRequest(items);
    const headers = this['_delegate']._transport?._transport?._parameters?.headers();

    if (headers) {
      const signedRequest = await this.authenticator.authenticate(this.endpoint, headers, serializedSpans);

      // See type: https://github.com/open-telemetry/opentelemetry-js/blob/experimental/v0.57.1/experimental/packages/otlp-exporter-base/src/transport/http-transport-types.ts#L31
      const newHeaders: () => Record<string, string> = () => signedRequest;
      this['_delegate']._transport._transport._parameters.headers = newHeaders;
    }

    super.export(items, resultCallback);
  }
}
