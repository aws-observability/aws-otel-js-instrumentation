// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OTLP LogRecord emitter for DI snapshots.
 *
 * Converts Snapshot objects into structured OTLP LogRecords with:
 * - Flat attributes (queryable in CloudWatch Logs Insights)
 * - Structured body (stack + captures as nested objects, auto-encoded as AnyValue)
 *
 * Uses a dedicated, isolated LoggerProvider in the worker thread — DI snapshots
 * do not mix with application logs or Application Signals.
 */

import { Context, diag, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { Logger, SeverityNumber, AnyValue } from '@opentelemetry/api-logs';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { Snapshot, Captures, CapturedValue, CapturedContext, StackFrame, CapturedThrowable } from './model/snapshot';

const INSTRUMENTATION_SCOPE = 'aws.dynamic_instrumentation';
const INSTRUMENTATION_VERSION = '1.0';
const EVENT_NAME = 'aws.dynamic_instrumentation.snapshot';
const DEFAULT_LOGS_ENDPOINT = 'http://localhost:4316/v1/logs';

export class SnapshotOtlpEmitter {
  private logger: Logger | null = null;
  private loggerProvider: LoggerProvider | null = null;
  private initFailed: boolean = false;
  private readonly logsEndpoint: string;
  private readonly serviceName: string;
  private readonly environment: string;

  constructor(logsEndpoint?: string, serviceName?: string, environment?: string) {
    const raw = logsEndpoint ?? process.env.OTEL_AWS_OTLP_LOGS_ENDPOINT ?? '';
    this.logsEndpoint = raw.trim() || DEFAULT_LOGS_ENDPOINT;
    this.serviceName = serviceName ?? '';
    this.environment = environment ?? '';
  }

  private ensureInitialized(): boolean {
    if (this.logger) return true;
    if (this.initFailed) return false;

    try {
      const resourceAttrs: Record<string, string> = {
        'service.name': this.serviceName || 'unknown_service',
      };
      if (this.environment) {
        resourceAttrs['deployment.environment'] = this.environment;
      }

      const exporter = new OTLPLogExporter({ url: this.logsEndpoint });
      this.loggerProvider = new LoggerProvider({
        resource: resourceFromAttributes(resourceAttrs),
        processors: [new BatchLogRecordProcessor(exporter)],
      });
      this.logger = this.loggerProvider.getLogger(INSTRUMENTATION_SCOPE, INSTRUMENTATION_VERSION);

      diag.debug(`DI: OTLP emitter initialized (endpoint: ${this.logsEndpoint})`);
      return true;
    } catch (error) {
      diag.warn('DI: Failed to initialize OTLP LoggerProvider, snapshots will not be exported', error);
      this.initFailed = true;
      return false;
    }
  }

  /**
   * Emit a DI snapshot as an OTLP LogRecord.
   */
  emitSnapshot(snapshot: Snapshot, instrumentationType?: string): void {
    if (!this.ensureInitialized()) return;

    try {
      const location = snapshot.instrumentation?.location;
      const isLineLevel = (location?.lineNumber ?? 0) > 0;

      // Build attributes
      const attributes: Record<string, string | number | boolean> = {
        'event.name': EVENT_NAME,
        'aws.di.snapshot_id': snapshot.id,
        'aws.di.location_hash': snapshot.locationHash ?? '',
        'aws.di.instrumentation_level': isLineLevel ? 'line' : 'method',
      };

      if (location?.codeUnit) attributes['aws.di.code_unit'] = location.codeUnit;
      if (location?.className) attributes['aws.di.class_name'] = location.className;
      if (location?.filePath) attributes['aws.di.file_path'] = location.filePath;
      if (isLineLevel && location?.lineNumber) {
        attributes['aws.di.line_number'] = location.lineNumber;
      }
      if (instrumentationType) {
        attributes['aws.di.instrumentation_type'] = instrumentationType;
      }

      // Build body with snake_case keys
      const body: Record<string, unknown> = {};

      if (snapshot.stack && snapshot.stack.length > 0) {
        body.stack = snapshot.stack.map(convertStackFrame);
      }

      if (snapshot.captures) {
        body.captures = convertCaptures(snapshot.captures as Captures);
      }

      // Build trace context for top-level traceId/spanId on the OTLP log record.
      // We use TraceFlags.SAMPLED because the snapshot is only emitted when a breakpoint
      // fires inside an active span — the span was necessarily being recorded. The actual
      // traceFlags value is not included in the snapshot payload to keep it simple.
      let logContext: Context | undefined;
      try {
        if (snapshot.trace?.traceId && snapshot.trace?.spanId) {
          logContext = trace.setSpanContext(ROOT_CONTEXT, {
            traceId: snapshot.trace.traceId,
            spanId: snapshot.trace.spanId,
            traceFlags: TraceFlags.SAMPLED,
          });
        }
      } catch {
        // If context construction fails, emit without trace correlation
      }

      // Emit LogRecord
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.logger!.emit({
        eventName: EVENT_NAME,
        timestamp: [Math.floor(snapshot.timestamp / 1000), (snapshot.timestamp % 1000) * 1_000_000],
        body: Object.keys(body).length > 0 ? (body as unknown as AnyValue) : undefined,
        attributes,
        severityNumber: SeverityNumber.INFO,
        context: logContext,
      });
    } catch (error) {
      diag.warn('DI: Error emitting snapshot as OTLP LogRecord', error);
    }
  }

  /**
   * Flush and shutdown the owned LoggerProvider.
   */
  async shutdown(): Promise<void> {
    if (this.loggerProvider) {
      try {
        await this.loggerProvider.forceFlush();
        await this.loggerProvider.shutdown();
        diag.debug('DI: OTLP LoggerProvider shut down');
      } catch (error) {
        diag.warn('DI: Error shutting down OTLP LoggerProvider', error);
      }
      this.loggerProvider = null;
      this.logger = null;
    }
  }
}

// --- Body key conversion helpers (camelCase → snake_case) ---

function convertStackFrame(frame: StackFrame): Record<string, unknown> {
  return {
    file_path: frame.fileName,
    function: frame.function,
    line_number: frame.lineNumber,
  };
}

function convertCaptures(captures: Captures): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (captures.entry) {
    result.entry = convertCapturedContext(captures.entry);
  }
  if (captures.return) {
    result.return = convertCapturedContext(captures.return);
  }
  if (captures.lines) {
    const lines: Record<string, unknown> = {};
    for (const [lineNum, ctx] of Object.entries(captures.lines)) {
      lines[lineNum] = convertCapturedContext(ctx as CapturedContext);
    }
    result.lines = lines;
  }

  return result;
}

function convertCapturedContext(ctx: CapturedContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (ctx.arguments) {
    result.arguments = convertCapturedValueMap(ctx.arguments);
  }
  if (ctx.locals) {
    result.locals = convertCapturedValueMap(ctx.locals);
  }
  if (ctx.returnValue) {
    result.return_value = convertCapturedValue(ctx.returnValue);
  }
  if (ctx.throwable) {
    result.throwable = convertThrowable(ctx.throwable);
  }

  return result;
}

function convertCapturedValueMap(map: Record<string, CapturedValue>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(map)) {
    result[key] = convertCapturedValue(val);
  }
  return result;
}

function convertCapturedValue(cv: CapturedValue): Record<string, unknown> {
  const result: Record<string, unknown> = { type: cv.type };

  if (cv.isNull) {
    result.is_null = true;
  } else if (cv.notCapturedReason) {
    result.not_captured_reason = cv.notCapturedReason;
  } else if (cv.value !== undefined) {
    result.value = cv.value;
  } else if (cv.fields) {
    result.fields = convertCapturedValueMap(cv.fields);
  } else if (cv.elements) {
    result.elements = cv.elements.map(convertCapturedValue);
  } else if (cv.entries) {
    result.entries = cv.entries.map(([k, v]) => ({
      key: convertCapturedValue(k),
      value: convertCapturedValue(v),
    }));
  }

  if (cv.truncated) result.truncated = true;
  if (cv.size !== undefined) result.size = cv.size;

  return result;
}

function convertThrowable(t: CapturedThrowable): Record<string, unknown> {
  return {
    type: t.type,
    message: t.message ?? '',
    stacktrace: (t.stacktrace ?? []).map(convertStackFrame),
  };
}
