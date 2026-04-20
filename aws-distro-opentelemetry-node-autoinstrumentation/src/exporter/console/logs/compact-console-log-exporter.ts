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

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    if (this._isShutdown) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    for (const logRecord of logs) {
      try {
        process.stdout.write(JSON.stringify(this._toCompactJson(logRecord)) + '\n');
      } catch (e) {
        diag.debug('Failed to serialize log record with standardized format, falling back to upstream SDK', e);
        this._getFallback().export([logRecord], () => {});
      }
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
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

  private _toCompactJson(logRecord: ReadableLogRecord): Record<string, unknown> {
    // Resource — preserve attribute value types
    const resourceAttrs: Record<string, unknown> = {};
    if (logRecord.resource?.attributes) {
      for (const [key, value] of Object.entries(logRecord.resource.attributes)) {
        resourceAttrs[key] = value;
      }
    }

    // Span context validity check
    const spanContext = logRecord.spanContext;
    const isValid =
      spanContext != null && spanContext.traceId !== INVALID_TRACEID && spanContext.spanId !== INVALID_SPANID;

    // Attributes — preserve value types
    const attrs: Record<string, unknown> = {};
    if (logRecord.attributes) {
      for (const [key, value] of Object.entries(logRecord.attributes)) {
        attrs[key] = value;
      }
    }

    // Severity text from severity number (OTel spec names)
    const severityText = severityNumberToText(logRecord.severityNumber);

    // Instrumentation scope
    const scope = logRecord.instrumentationScope;

    return {
      resource: {
        attributes: resourceAttrs,
        schemaUrl: logRecord.resource?.schemaUrl ?? '',
      },
      scope: {
        name: scope?.name ?? '',
        version: scope?.version ?? '',
        schemaUrl: scope?.schemaUrl ?? '',
      },
      body: logRecord.body ?? null,
      severityNumber: logRecord.severityNumber ?? 0,
      severityText,
      attributes: attrs,
      droppedAttributes: logRecord.droppedAttributesCount ?? 0,
      timeUnixNano: hrTimeToNanos(logRecord.hrTime),
      observedTimeUnixNano: hrTimeToNanos(logRecord.hrTimeObserved),
      traceId: isValid ? spanContext!.traceId : '',
      spanId: isValid ? spanContext!.spanId : '',
      flags: spanContext?.traceFlags ?? 0,
      exportPath: 'console',
    };
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
  return (BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1])).toString();
}

/**
 * Map severity number to OTel spec severity text.
 * SeverityNumber enum in JS has bidirectional mapping (e.g. SeverityNumber[9] === "INFO").
 */
function severityNumberToText(severityNumber: SeverityNumber | undefined): string {
  if (severityNumber == null || severityNumber === SeverityNumber.UNSPECIFIED) {
    return 'UNSPECIFIED';
  }
  return SeverityNumber[severityNumber] ?? 'UNSPECIFIED';
}
