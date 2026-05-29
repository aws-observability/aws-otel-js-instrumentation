// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { diag, INVALID_TRACEID, INVALID_SPANID } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ConsoleLogRecordExporter, LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';

/**
 * Exports log records as compact JSON to stdout.
 *
 * Produces a single-line JSON object per log record matching the canonical
 * schema shared across all ADOT language implementations. This exporter is
 * used in AWS Lambda environments when OTEL_LOGS_EXPORTER=console.
 *
 * If the standardized serialization fails for any reason, falls back to
 * the upstream SDK's ConsoleLogRecordExporter format to avoid breaking
 * existing infrastructure.
 */
export class CompactConsoleLogRecordExporter implements LogRecordExporter {
  private _isShutdown: boolean = false;
  private _fallback: ConsoleLogRecordExporter | undefined;
  private readonly _exportPathEnabled: boolean = process.env.ADOT_TEST_EXPORT_PATH_ENABLED === 'true';

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    if (this._isShutdown) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    let hasFailures = false;
    for (const logRecord of logs) {
      try {
        process.stdout.write(JSON.stringify(this._buildLogRecord(logRecord)) + '\n');
      } catch (e) {
        diag.debug('Failed to serialize log record with standardized format, falling back to upstream SDK', e);
        try {
          process.stdout.write(JSON.stringify(this._getFallback()['_exportInfo'](logRecord)) + '\n');
        } catch (fallbackError) {
          diag.debug('Fallback serialization also failed', fallbackError);
          hasFailures = true;
        }
      }
    }
    resultCallback({ code: hasFailures ? ExportResultCode.FAILED : ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    this._isShutdown = true;
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private _getFallback(): ConsoleLogRecordExporter {
    if (!this._fallback) {
      this._fallback = new ConsoleLogRecordExporter();
    }
    return this._fallback;
  }

  // Aligns with other ADOT SDKs and the CloudWatch OTLP backend schema.
  private _buildLogRecord(logRecord: ReadableLogRecord): Record<string, unknown> {
    const spanContext = logRecord.spanContext;
    const isValid =
      spanContext != null && spanContext.traceId !== INVALID_TRACEID && spanContext.spanId !== INVALID_SPANID;
    const scope = logRecord.instrumentationScope;

    const record: Record<string, unknown> = {
      resource: {
        attributes: logRecord.resource?.attributes ?? {},
        schemaUrl: logRecord.resource?.schemaUrl ?? '',
      },
      scope: {
        name: scope?.name ?? '',
        version: scope?.version ?? '',
        schemaUrl: scope?.schemaUrl ?? '',
      },
      body: logRecord.body ?? null,
      severityNumber: logRecord.severityNumber ?? 0,
      severityText: logRecord.severityText || severityNumberToText(logRecord.severityNumber),
      attributes: logRecord.attributes ?? {},
      droppedAttributes: logRecord.droppedAttributesCount ?? 0,
      timeUnixNano: hrTimeToNanos(logRecord.hrTime),
      observedTimeUnixNano: hrTimeToNanos(logRecord.hrTimeObserved),
      traceId: isValid ? spanContext!.traceId : '',
      spanId: isValid ? spanContext!.spanId : '',
      flags: isValid ? spanContext!.traceFlags : 0,
    };

    if (this._exportPathEnabled) {
      record.exportPath = 'console';
    }

    return record;
  }
}

/**
 * Convert HrTime [seconds, nanoseconds] to epoch nanoseconds as string.
 * Uses BigInt to avoid precision loss beyond Number.MAX_SAFE_INTEGER.
 */
function hrTimeToNanos(hrTime: [number, number] | undefined): string {
  if (!hrTime || (hrTime[0] === 0 && hrTime[1] === 0)) {
    return '0';
  }
  // eslint-disable-next-line no-undef
  return (BigInt(hrTime[0]) * BigInt(1000000000) + BigInt(hrTime[1])).toString();
}

function severityNumberToText(severityNumber: SeverityNumber | undefined): string {
  if (severityNumber == null || severityNumber === SeverityNumber.UNSPECIFIED) {
    return 'UNSPECIFIED';
  }
  return SeverityNumber[severityNumber] ?? 'UNSPECIFIED';
}
