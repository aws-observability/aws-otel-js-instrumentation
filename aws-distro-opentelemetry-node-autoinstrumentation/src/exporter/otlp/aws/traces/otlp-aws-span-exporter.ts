// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { CompressionAlgorithm, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';
import { IExportTraceServiceResponse, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPAwsBaseExporter } from '../common/otlp-aws-base-exporter';
import { LLOHandler } from '../../../../llo-handler';
import { LoggerProvider as APILoggerProvider, logs } from '@opentelemetry/api-logs';
import { ExportResult } from '@opentelemetry/core';
import { isAgentObservabilityEnabled } from '../../../../utils';
import { diag } from '@opentelemetry/api';
import { LoggerProvider } from '@opentelemetry/sdk-logs';

/**
 * This exporter extends the functionality of the OTLPProtoTraceExporter to allow spans to be exported
 * to the XRay OTLP endpoint https://xray.[AWSRegion].amazonaws.com/v1/traces. Utilizes the aws-sdk
 * library to sign and directly inject SigV4 Authentication to the exported request's headers. <a
 * href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html">...</a>
 *
 * This only works with version >=16 Node.js environments.
 *
 * @param endpoint - The AWS X-Ray OTLP endpoint URL
 * @param config - Optional OTLP exporter configuration
 */
export class OTLPAwsSpanExporter
  extends OTLPAwsBaseExporter<ReadableSpan[], IExportTraceServiceResponse>
  implements SpanExporter
{
  private loggerProvider: APILoggerProvider | undefined;
  private lloHandler: LLOHandler | undefined;

  constructor(endpoint: string, config?: OTLPExporterNodeConfigBase, loggerProvider?: APILoggerProvider) {
    const modifiedConfig: OTLPExporterNodeConfigBase = {
      ...config,
      url: endpoint,
      compression: CompressionAlgorithm.NONE,
    };

    super(endpoint, 'xray', new OTLPProtoTraceExporter(modifiedConfig), ProtobufTraceSerializer, config?.compression);

    this.lloHandler = undefined;
    this.loggerProvider = loggerProvider;
  }

  // Lazily initialize LLO handler when needed to avoid initialization order issues
  private ensureLloHandler(): boolean {
    if (!this.lloHandler && isAgentObservabilityEnabled()) {
      // If loggerProvider wasn't provided, try to get the current one
      if (!this.loggerProvider) {
        try {
          this.loggerProvider = logs.getLoggerProvider();
        } catch (e: unknown) {
          diag.debug('Failed to get logger provider', e);
          return false;
        }
      }

      if (this.loggerProvider instanceof LoggerProvider) {
        this.lloHandler = new LLOHandler(this.loggerProvider);
        return true;
      }
    }

    return !!this.lloHandler;
  }

  override async export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): Promise<void> {
    let itemsToSerialize: ReadableSpan[] = items;
    if (isAgentObservabilityEnabled() && this.ensureLloHandler() && this.lloHandler) {
      // items to serialize are now the lloProcessedSpans
      itemsToSerialize = this.lloHandler.processSpans(items);
    }

    return super.export(itemsToSerialize, resultCallback);
  }
}
