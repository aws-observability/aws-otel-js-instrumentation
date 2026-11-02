// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-testing file exporter producing CloudWatch-faithful NDJSON.
 *
 * When `OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE` is set, `ServiceEventsOtlpEmitter`
 * constructs these exporters instead of the OTLP network exporters.
 * The output shape matches what users see in CloudWatch Logs Insights:
 *
 *   - Logs   : one NDJSON line per LogRecord with top-level
 *              eventName/timeUnixNano/attributes/body plus nested
 *              `resource`.
 *   - Metrics: one NDJSON line per export batch as a canonical OTLP/JSON
 *              ExportMetricsServiceRequest — byte-identical to the OTLP wire,
 *              covering both `count` (Sum, §7) and `service.function.duration`
 *              (ExponentialHistogram, §4).
 *
 * Both exporters append to the same file via a writer singleton keyed
 * on absolute path — one fs.createWriteStream per file, single Node
 * event loop queues writes serially so lines don't interleave.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createStream, RotatingFileStream } from 'rotating-file-stream';
import { diag, HrTime } from '@opentelemetry/api';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ReadableLogRecord, LogRecordExporter } from '@opentelemetry/sdk-logs';
import {
  AggregationOption,
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { JsonMetricsSerializer } from '@opentelemetry/otlp-transformer';

// ─── writer singleton ────────────────────────────────────────────────

// Output-file rotation policy. When the active file reaches MAX_SIZE it is
// renamed to <file>.1, existing backups shift one slot, and <file>.{MAX_FILES}
// is dropped. Bounds total disk footprint per output path at
// (MAX_FILES + 1) * MAX_SIZE.
export const ROTATION_MAX_SIZE = '50M';
export const ROTATION_MAX_FILES = 5;

interface FileWriterHandle {
  stream: RotatingFileStream;
  refCount: number;
}

const writers = new Map<string, FileWriterHandle>();

// Mutable for test-only override via _setRotationSizeForTests.
let rotationSize: string = ROTATION_MAX_SIZE;
let rotationMaxFiles: number = ROTATION_MAX_FILES;

/**
 * Open or share the writer for `absPath`. Returns `undefined` if the path
 * cannot be opened — callers must tolerate a missing stream so I/O failures
 * don't propagate into the customer application.
 */
function acquireWriter(absPath: string): RotatingFileStream | undefined {
  const existing = writers.get(absPath);
  if (existing) {
    existing.refCount += 1;
    return existing.stream;
  }
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    // `rotate: N` selects logrotate-style suffixes (<file>.1 … <file>.N with
    // shift-on-rollover and oldest dropped). The alternative `maxFiles` option
    // produces timestamped names.
    const stream = createStream(path.basename(absPath), {
      path: path.dirname(absPath),
      size: rotationSize,
      rotate: rotationMaxFiles,
    });
    stream.on('error', err => diag.warn(`ServiceEvents: file writer error (${absPath}): ${err}`));
    writers.set(absPath, { stream, refCount: 1 });
    return stream;
  } catch (err) {
    diag.warn(`ServiceEvents: failed to open output file ${absPath}`, err);
    return undefined;
  }
}

function releaseWriter(absPath: string): Promise<void> {
  const entry = writers.get(absPath);
  if (!entry) return Promise.resolve();
  entry.refCount -= 1;
  if (entry.refCount > 0) return Promise.resolve();
  writers.delete(absPath);
  return new Promise<void>(resolve => {
    entry.stream.end(() => resolve());
  });
}

/**
 * Resolve `outputPath` and acquire its writer without ever throwing back into
 * the caller. Returns an empty `absPath` and undefined `stream` if the path is
 * invalid (non-string, null, etc.) or the underlying file can't be opened.
 *
 * Telemetry SDK code MUST NOT propagate failures into the customer
 * application; this is the single entry point both file exporter
 * constructors use to enforce that contract.
 */
function safeAcquireWriter(outputPath: string): { absPath: string; stream: RotatingFileStream | undefined } {
  let absPath = '';
  try {
    absPath = path.resolve(outputPath);
  } catch (err) {
    diag.warn(`ServiceEvents: invalid output file path ${String(outputPath)}`, err);
    return { absPath: '', stream: undefined };
  }
  return { absPath, stream: acquireWriter(absPath) };
}

/** Test-only: reset writer map between tests. */
export function _resetFileWriters(): void {
  for (const [, entry] of writers) {
    entry.stream.end();
  }
  writers.clear();
  // Restore rotation defaults so subsequent tests start from a clean slate.
  rotationSize = ROTATION_MAX_SIZE;
  rotationMaxFiles = ROTATION_MAX_FILES;
}

/** Test-only: override rotation thresholds. Subsequent acquireWriter() calls pick up the new values. */
export function _setRotationConfigForTests(size: string, maxFiles: number): void {
  rotationSize = size;
  rotationMaxFiles = maxFiles;
}

// ─── encoding helpers ────────────────────────────────────────────────

/** Convert HrTime `[sec, nsec]` to nanoseconds as a plain number. */
function hrTimeToNanos(time: HrTime): number {
  // HrTime tuple: [seconds, nanoseconds]. Multiply + add.
  // Number is fine for event timestamps — nanos fit in 53-bit mantissa
  // for dates through year 2255.
  return time[0] * 1_000_000_000 + time[1];
}

/** Convert a hex trace/span id buffer to a lowercase hex string. */
function hexOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value;
}

/**
 * Unwrap an OTLP AnyValue-like body into a plain JSON-serializable
 * value. JS's sdk-logs already exposes `body` as a plain object/string
 * when the user called `LogRecord.emit({body: {...}})` — this pass is
 * a safety net that recursively strips any lingering wrappers.
 */
function unwrapBody(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(unwrapBody);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = unwrapBody(v);
    }
    return out;
  }
  return value;
}

/** Build the flat CloudWatch-shape JSON for one LogRecord. */
export function serializeLogRecord(record: ReadableLogRecord): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.attributes ?? {})) {
    attrs[k] = v;
  }

  const resource: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.resource.attributes ?? {})) {
    resource[k] = v;
  }

  const out: Record<string, unknown> = {
    eventName: record.eventName ?? '',
    timeUnixNano: hrTimeToNanos(record.hrTime),
    attributes: attrs,
    body: unwrapBody(record.body) ?? {},
    resource,
  };

  const traceId = hexOrUndefined(record.spanContext?.traceId);
  if (traceId) {
    out.traceId = traceId;
    out.spanId = record.spanContext!.spanId;
    out.flags = record.spanContext!.traceFlags;
  }

  return out;
}

// ─── exporters ───────────────────────────────────────────────────────

/**
 * CloudWatch-faithful log record exporter.
 *
 * Implements the upstream {@link LogRecordExporter} interface so it
 * slots into `BatchLogRecordProcessor` in place of the OTLP HTTP/gRPC
 * exporter.
 */
export class ServiceEventsCloudWatchLogFileExporter implements LogRecordExporter {
  private readonly absPath: string;
  private readonly stream: RotatingFileStream | undefined;
  private shutdownCalled: boolean = false;

  constructor(outputPath: string) {
    const acquired = safeAcquireWriter(outputPath);
    this.absPath = acquired.absPath;
    this.stream = acquired.stream;
  }

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    if (this.shutdownCalled || this.stream === undefined) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    try {
      for (const rec of records) {
        this.stream.write(JSON.stringify(serializeLogRecord(rec)) + '\n');
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      diag.warn('ServiceEvents: error writing log records to file', err);
      resultCallback({ code: ExportResultCode.FAILED, error: err as Error });
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    if (this.stream === undefined) return;
    await releaseWriter(this.absPath);
  }

  forceFlush(): Promise<void> {
    // File writes are synchronous within export(); nothing to flush.
    return Promise.resolve();
  }
}

/**
 * Canonical OTLP/JSON metric exporter.
 *
 * Implements the upstream {@link PushMetricExporter} interface so it
 * slots into `PeriodicExportingMetricReader` in place of the OTLP
 * HTTP/gRPC metric exporter. Each `export()` batch is written as ONE
 * NDJSON line containing a full OTLP `ExportMetricsServiceRequest`
 * (`resourceMetrics[].scopeMetrics[].metrics[]`), byte-identical to what
 * the CloudWatch OTLP metrics endpoint accepts. This is a pure transport
 * swap of the OTLP HTTP exporter, so both `count` (Sum) and
 * `service.function.duration` (ExponentialHistogram) serialize natively
 * with no per-type special-casing.
 */
export class ServiceEventsCloudWatchMetricFileExporter implements PushMetricExporter {
  private readonly absPath: string;
  private readonly stream: RotatingFileStream | undefined;
  private shutdownCalled: boolean = false;

  constructor(outputPath: string) {
    const acquired = safeAcquireWriter(outputPath);
    this.absPath = acquired.absPath;
    this.stream = acquired.stream;
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    if (this.shutdownCalled || this.stream === undefined) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    try {
      // Encode the whole batch to a single OTLP/JSON ExportMetricsServiceRequest,
      // exactly as the OTLP HTTP exporter does on the wire. One NDJSON line per batch.
      const encoded = JsonMetricsSerializer.serializeRequest(metrics);
      if (encoded !== undefined) {
        this.stream.write(new TextDecoder().decode(encoded) + '\n');
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      diag.warn('ServiceEvents: error writing metrics to file', err);
      resultCallback({ code: ExportResultCode.FAILED, error: err as Error });
    }
  }

  selectAggregationTemporality(_instrumentType: InstrumentType): AggregationTemporality {
    return AggregationTemporality.DELTA;
  }

  /**
   * Mirror the network exporter's aggregation preference so the file mirror
   * is a true transport swap. The OTLP network exporter forwards
   * `aggregationPreference` into the MetricReader via `selectAggregation`;
   * the MeterProvider itself takes no selector. Without this, Histograms
   * default to explicit-bucket and `service.function.duration` would NOT
   * serialize as the exponential histogram the backend expects.
   */
  selectAggregation(instrumentType: InstrumentType): AggregationOption {
    if (instrumentType === InstrumentType.HISTOGRAM) {
      return { type: AggregationType.EXPONENTIAL_HISTOGRAM };
    }
    return { type: AggregationType.DEFAULT };
  }

  async forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    if (this.stream === undefined) return;
    await releaseWriter(this.absPath);
  }
}
