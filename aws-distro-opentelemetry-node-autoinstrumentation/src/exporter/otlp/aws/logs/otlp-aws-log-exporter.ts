// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPLogExporter as OTLPProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { CompressionAlgorithm, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';

import { ProtobufLogsSerializer } from '@opentelemetry/otlp-transformer';
import { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { AwsAuthenticator } from '../common/aws-authenticator';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';

/**
 * This exporter extends the functionality of the OTLPProtoLogExporter to allow spans to be exported
 * to the CloudWatch Logs OTLP endpoint https://logs.[AWSRegion].amazonaws.com/v1/logs. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 */

export const LARGE_LOG_HEADER = 'x-aws-truncatable-fields';

export class OTLPAwsLogExporter extends OTLPProtoLogExporter {
  private endpoint: string;
  private region: string;
  private authenticator: AwsAuthenticator;
  private genAIFlag: boolean;

  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase) {
    let modifiedConfig: OTLPExporterNodeConfigBase = {
      url: endpoint,
      compression: CompressionAlgorithm.GZIP,
    };

    if (config) {
      modifiedConfig = {
        ...config,
        url: endpoint,
        compression: CompressionAlgorithm.GZIP,
      };
    }

    super(modifiedConfig);
    this.region = endpoint.split('.')[1];
    this.endpoint = endpoint;
    this.genAIFlag = false;
    this.authenticator = new AwsAuthenticator(this.region, 'logs');
  }

  /**
   * Overrides the upstream implementation of export. All behaviors are the same except if the
   * endpoint is the CloudWatch Logs OTLP endpoint, we will sign the request with SigV4 in headers before
   * sending it to the endpoint. Otherwise, we will skip signing.
   */

  // Upstream already implements a retry mechanism:
  // https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/otlp-exporter-base/src/retrying-transport.ts

  public override async export(
    items: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void
  ): Promise<void> {
    const serializedLogs: Uint8Array | undefined = ProtobufLogsSerializer.serializeRequest(items);

    if (serializedLogs === undefined) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Nothing to send'),
      });
      return;
    }

    const headers = this['_delegate']._transport?._transport?._parameters?.headers();

    if (headers) {
      const signedRequest = await this.authenticator.authenticate(this.endpoint, headers, serializedLogs);

      if (this.genAIFlag) {
        signedRequest[LARGE_LOG_HEADER] = 'body/content';
      } else {
        delete signedRequest[LARGE_LOG_HEADER];
      }

      // See type: https://github.com/open-telemetry/opentelemetry-js/blob/experimental/v0.57.1/experimental/packages/otlp-exporter-base/src/transport/http-transport-types.ts#L31
      const newHeaders: () => Record<string, string> = () => signedRequest;
      this['_delegate']._transport._transport._parameters.headers = newHeaders;
    }

    super.export(items, resultCallback);
    this.genAIFlag = false;
  }

  public setGenAIFlag() {
    this.genAIFlag = true;
  }
}
