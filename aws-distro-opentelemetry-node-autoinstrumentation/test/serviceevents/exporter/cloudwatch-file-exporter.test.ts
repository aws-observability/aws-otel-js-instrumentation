// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HrTime, SpanContext, TraceFlags } from '@opentelemetry/api';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  AggregationType,
  DataPointType,
  InstrumentType,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';

import {
  ServiceEventsCloudWatchLogFileExporter,
  ServiceEventsCloudWatchMetricFileExporter,
  serializeLogRecord,
  _resetFileWriters,
  _setRotationConfigForTests,
} from '../../../src/serviceevents/exporter/cloudwatch-file-exporter';

// ─── helpers ─────────────────────────────────────────────────────────

function makeTempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'serviceevents-cwfile-')), 'out.ndjson');
}

function readLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line));
}

function awaitExport(
  exporter: {
    export: (batch: any, cb: (r: ExportResult) => void) => void;
  },
  batch: any
): Promise<ExportResult> {
  return new Promise(resolve => exporter.export(batch, resolve));
}

function makeResource(attrs: Record<string, string | number | boolean>) {
  return resourceFromAttributes(attrs);
}

function makeLogRecord(overrides: Partial<ReadableLogRecord> = {}): ReadableLogRecord {
  const resource =
    overrides.resource ??
    makeResource({
      'service.name': 'shoppingcart',
      'deployment.environment': 'prod',
      'telemetry.sdk.language': 'nodejs',
    });
  const baseHrTime: HrTime = overrides.hrTime ?? [1744137998, 974205000];
  return {
    hrTime: baseHrTime,
    hrTimeObserved: baseHrTime,
    spanContext: overrides.spanContext,
    severityText: undefined,
    severityNumber: undefined,
    body: overrides.body ?? { exceptions: { RuntimeError: 3 } },
    resource,
    instrumentationScope: { name: 'serviceevents', version: '1.0' },
    attributes: overrides.attributes ?? {
      'event.name': 'aws.service_events.function_call',
      'aws.service_events.function_name': 'process_order',
    },
    droppedAttributesCount: 0,
    eventName: overrides.eventName ?? 'aws.service_events.function_call',
  } as ReadableLogRecord;
}

// ─── tests ───────────────────────────────────────────────────────────

describe('ServiceEventsCloudWatchLogFileExporter', function () {
  afterEach(function () {
    _resetFileWriters();
  });

  it('serializes a LogRecord to the spec-faithful flat shape', function () {
    const record = makeLogRecord();
    const out = serializeLogRecord(record);

    expect(out.eventName).toBe('aws.service_events.function_call');
    expect(out.timeUnixNano).toBe(1744137998 * 1_000_000_000 + 974205000);
    expect(out.attributes).toEqual({
      'event.name': 'aws.service_events.function_call',
      'aws.service_events.function_name': 'process_order',
    });
    expect(out.body).toEqual({ exceptions: { RuntimeError: 3 } });
    expect(out.resource).toEqual({
      'service.name': 'shoppingcart',
      'deployment.environment': 'prod',
      'telemetry.sdk.language': 'nodejs',
    });
    expect(out.traceId).toBeUndefined();
    expect(out.spanId).toBeUndefined();
    expect(out.flags).toBeUndefined();
  });

  it('includes traceId/spanId/flags when LogRecord has span context', function () {
    const spanContext: SpanContext = {
      traceId: 'aabbccddeeff00112233445566778899',
      spanId: '1122334455667788',
      traceFlags: TraceFlags.SAMPLED,
    };
    const out = serializeLogRecord(makeLogRecord({ spanContext }));
    expect(out.traceId).toBe('aabbccddeeff00112233445566778899');
    expect(out.spanId).toBe('1122334455667788');
    expect(out.flags).toBe(1);
  });

  it('writes one NDJSON line per record', async function () {
    const filePath = makeTempFile();
    const exporter = new ServiceEventsCloudWatchLogFileExporter(filePath);
    const result = await awaitExport(exporter, [
      makeLogRecord({ eventName: 'aws.service_events.function_call' }),
      makeLogRecord({ eventName: 'aws.service_events.endpoint_summary' }),
    ]);
    await exporter.shutdown();

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    const lines = readLines(filePath);
    expect(lines.length).toBe(2);
    expect((lines[0] as any).eventName).toBe('aws.service_events.function_call');
    expect((lines[1] as any).eventName).toBe('aws.service_events.endpoint_summary');
  });

  it('appends across multiple export calls', async function () {
    const filePath = makeTempFile();
    const exporter = new ServiceEventsCloudWatchLogFileExporter(filePath);
    await awaitExport(exporter, [makeLogRecord()]);
    await awaitExport(exporter, [makeLogRecord()]);
    await exporter.shutdown();
    expect(readLines(filePath).length).toBe(2);
  });

  it('handles empty batch without error', async function () {
    const filePath = makeTempFile();
    const exporter = new ServiceEventsCloudWatchLogFileExporter(filePath);
    const result = await awaitExport(exporter, []);
    await exporter.shutdown();
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(readLines(filePath).length).toBe(0);
  });

  it('rejects export after shutdown', async function () {
    const filePath = makeTempFile();
    const exporter = new ServiceEventsCloudWatchLogFileExporter(filePath);
    await exporter.shutdown();
    const result = await awaitExport(exporter, [makeLogRecord()]);
    expect(result.code).toBe(ExportResultCode.FAILED);
  });
});

describe('ServiceEventsCloudWatchMetricFileExporter', function () {
  afterEach(function () {
    _resetFileWriters();
  });

  function makeMetricsBatch(): ResourceMetrics {
    const resource = makeResource({ 'service.name': 'shoppingcart' });
    return {
      resource,
      scopeMetrics: [
        {
          scope: { name: 'serviceevents', version: '1.0' },
          metrics: [
            {
              descriptor: {
                name: 'count',
                description: 'ServiceEvents EndpointErrorMetrics counter',
                unit: 'Count',
                type: InstrumentType.COUNTER,
                valueType: 1 as any,
              },
              dataPointType: DataPointType.SUM,
              isMonotonic: true,
              aggregationTemporality: AggregationTemporality.DELTA,
              dataPoints: [
                {
                  attributes: {
                    'Telemetry.Source': 'ServiceEvents',
                    service_name: 'shoppingcart',
                    environment: 'prod',
                    operation: 'POST /api/checkout',
                    exception: 'RuntimeError',
                  },
                  startTime: [1744137900, 0] as HrTime,
                  endTime: [1744137960, 0] as HrTime,
                  value: 3,
                },
              ],
            } as any,
          ],
        },
      ],
    };
  }

  function makeHistogramBatch(): ResourceMetrics {
    const resource = makeResource({ 'service.name': 'shoppingcart' });
    return {
      resource,
      scopeMetrics: [
        {
          scope: { name: 'serviceevents', version: '1.0' },
          metrics: [
            {
              descriptor: {
                name: 'service.function.duration',
                description: 'Function call duration',
                unit: 'Microseconds',
                type: InstrumentType.HISTOGRAM,
                valueType: 1 as any,
              },
              dataPointType: DataPointType.EXPONENTIAL_HISTOGRAM,
              aggregationTemporality: AggregationTemporality.DELTA,
              dataPoints: [
                {
                  attributes: { 'Telemetry.Source': 'ServiceEvents', 'function.name': 'app.handle', status: 'success' },
                  startTime: [1744137900, 0] as HrTime,
                  endTime: [1744137960, 0] as HrTime,
                  value: {
                    count: 3,
                    sum: 16166,
                    scale: 4,
                    zeroCount: 0,
                    positive: { offset: 47, bucketCounts: [1, 2] },
                    negative: { offset: 0, bucketCounts: [] },
                    min: 1500,
                    max: 3875,
                  },
                },
              ],
            } as any,
          ],
        },
      ],
    };
  }

  it('writes one OTLP/JSON ExportMetricsServiceRequest line per batch (Sum)', async function () {
    const filePath = makeTempFile();
    const exporter = new ServiceEventsCloudWatchMetricFileExporter(filePath);
    const result = await awaitExport(exporter, makeMetricsBatch());
    await exporter.shutdown();

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    const lines = readLines(filePath) as any[];
    // One line per export batch, not per data point.
    expect(lines.length).toBe(1);
    const req = lines[0];
    const metric = req.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(req.resourceMetrics[0].scopeMetrics[0].scope.name).toBe('serviceevents');
    // Metric name stays lowercase (no count→Count capitalization); no EMF envelope.
    expect(metric.name).toBe('count');
    expect(metric.sum.isMonotonic).toBe(true);
    expect(metric.sum.dataPoints[0].asDouble).toBe(3);
    // Data-point attributes survive marshaling (Telemetry.Source maps to a stringValue).
    expect(
      metric.sum.dataPoints[0].attributes.some(
        (a: any) => a.key === 'Telemetry.Source' && a.value.stringValue === 'ServiceEvents'
      )
    ).toBe(true);
    // OTLP proto enum: AGGREGATION_TEMPORALITY_DELTA = 1 (distinct from the SDK's
    // AggregationTemporality.DELTA = 0). The file exporter forces Delta to match the wire.
    expect(metric.sum.aggregationTemporality).toBe(1);
    expect(req._aws).toBeUndefined();
  });

  it('serializes ExponentialHistogram natively as OTLP/JSON', async function () {
    const filePath = makeTempFile();
    const exporter = new ServiceEventsCloudWatchMetricFileExporter(filePath);
    const result = await awaitExport(exporter, makeHistogramBatch());
    await exporter.shutdown();

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    const lines = readLines(filePath) as any[];
    expect(lines.length).toBe(1);
    const metric = lines[0].resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.name).toBe('service.function.duration');
    expect(metric.unit).toBe('Microseconds');
    // Histogram is not dropped, not EMF — serializes natively as exponentialHistogram.
    expect(metric.exponentialHistogram).toBeDefined();
    expect(metric.exponentialHistogram.dataPoints[0].count).toBe(3);
    expect(metric.exponentialHistogram.dataPoints[0].scale).toBe(4);
    // Histogram temporality is also Delta (proto enum = 1), matching the Sum + the wire.
    expect(metric.exponentialHistogram.aggregationTemporality).toBe(1);
  });

  it('log + metric exporters share a single file', async function () {
    const filePath = makeTempFile();
    const logExporter = new ServiceEventsCloudWatchLogFileExporter(filePath);
    const metricExporter = new ServiceEventsCloudWatchMetricFileExporter(filePath);
    await awaitExport(logExporter, [makeLogRecord()]);
    await awaitExport(metricExporter, makeMetricsBatch());
    await logExporter.shutdown();
    await metricExporter.shutdown();

    const lines = readLines(filePath) as any[];
    expect(lines.length).toBe(2);
    // Logs keep the flat CloudWatch-Insights shape (eventName); metrics are OTLP JSON.
    expect(lines.some(l => l.eventName === 'aws.service_events.function_call')).toBe(true);
    expect(lines.some(l => l.resourceMetrics)).toBe(true);
  });

  it('selectAggregationTemporality returns DELTA', function () {
    const exporter = new ServiceEventsCloudWatchMetricFileExporter(makeTempFile());
    expect(exporter.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(AggregationTemporality.DELTA);
  });

  it('selectAggregation forces EXPONENTIAL_HISTOGRAM for histograms (matches network exporter)', function () {
    const exporter = new ServiceEventsCloudWatchMetricFileExporter(makeTempFile());
    expect(exporter.selectAggregation(InstrumentType.HISTOGRAM)).toEqual({
      type: AggregationType.EXPONENTIAL_HISTOGRAM,
    });
    // Non-histogram instruments use the SDK default.
    expect(exporter.selectAggregation(InstrumentType.COUNTER)).toEqual({ type: AggregationType.DEFAULT });
  });
});

describe('rotation policy', function () {
  // rotating-file-stream rotates asynchronously after a write that crosses the
  // size threshold; give it a chance to rename + reopen before reading state.
  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function backupPaths(filePath: string): string[] {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    return fs
      .readdirSync(dir)
      .filter(name => name.startsWith(base + '.'))
      .map(name => path.join(dir, name))
      .sort();
  }

  afterEach(function () {
    _resetFileWriters();
  });

  it('does not rotate below the threshold', async function () {
    _setRotationConfigForTests('10K', 5);
    const filePath = makeTempFile();
    const exporter = new ServiceEventsCloudWatchLogFileExporter(filePath);
    // ~5 records, each ~250B serialized → ~1.25 KiB, well below 10 KiB.
    await awaitExport(exporter, [makeLogRecord(), makeLogRecord(), makeLogRecord(), makeLogRecord(), makeLogRecord()]);
    await exporter.shutdown();
    await delay(50);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(backupPaths(filePath)).toEqual([]);
  });

  it('rotates at the threshold', async function () {
    _setRotationConfigForTests('500B', 5);
    const filePath = makeTempFile();
    const exporter = new ServiceEventsCloudWatchLogFileExporter(filePath);
    // 500B threshold + 10 batches of 3 records (~250B each) = far past threshold.
    for (let i = 0; i < 10; i++) {
      await awaitExport(exporter, [makeLogRecord(), makeLogRecord(), makeLogRecord()]);
      await delay(30);
    }
    await delay(150);
    await exporter.shutdown();
    await delay(50);
    const backups = backupPaths(filePath);
    expect(backups.length).toBeGreaterThanOrEqual(1);
    // First backup must use the .1 suffix per the documented policy.
    expect(backups.some(p => p.endsWith('.1'))).toBe(true);
  });

  it('caps backups at 5 (oldest dropped)', async function () {
    _setRotationConfigForTests('500B', 5);
    const filePath = makeTempFile();
    const exporter = new ServiceEventsCloudWatchLogFileExporter(filePath);
    // Drive far more than 5 rotations: many small batches at 500-byte threshold.
    for (let i = 0; i < 15; i++) {
      await awaitExport(exporter, [makeLogRecord(), makeLogRecord(), makeLogRecord()]);
      await delay(20);
    }
    await delay(100);
    await exporter.shutdown();
    await delay(50);
    const backups = backupPaths(filePath);
    expect(backups.length).toBeLessThanOrEqual(5);
    // <file>.6 must never exist with maxFiles=5.
    expect(fs.existsSync(filePath + '.6')).toBe(false);
  });
});

describe('exporter error handling', function () {
  // Constructing an exporter on an unopenable path MUST NOT throw — telemetry
  // code is forbidden from crashing the customer application.
  afterEach(function () {
    _resetFileWriters();
  });

  function unopenablePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceevents-bogus-'));
    const plainFile = path.join(dir, 'regular-file');
    fs.writeFileSync(plainFile, '');
    // mkdir under a regular file fails with ENOTDIR; createStream + mkdir
    // both run inside acquireWriter's try/catch.
    return path.join(plainFile, 'nested', 'svc.ndjson');
  }

  it('log exporter survives an unopenable path', async function () {
    const exporter = new ServiceEventsCloudWatchLogFileExporter(unopenablePath());
    const result = await awaitExport(exporter, [makeLogRecord()]);
    expect(result.code).toBe(ExportResultCode.FAILED);
    // shutdown must be a safe no-op when no stream was acquired.
    await exporter.shutdown();
  });

  it('metric exporter survives an unopenable path', async function () {
    const exporter = new ServiceEventsCloudWatchMetricFileExporter(unopenablePath());
    const emptyMetrics: ResourceMetrics = { resource: resourceFromAttributes({}), scopeMetrics: [] };
    const result = await awaitExport(exporter, emptyMetrics);
    expect(result.code).toBe(ExportResultCode.FAILED);
    await exporter.shutdown();
  });

  // path.resolve throws TypeError on non-string input; constructor must not
  // propagate that into customer app code.
  it('log exporter survives a non-string path', async function () {
    expect(() => new ServiceEventsCloudWatchLogFileExporter(undefined as unknown as string)).not.toThrow();
    const exporter = new ServiceEventsCloudWatchLogFileExporter(undefined as unknown as string);
    const result = await awaitExport(exporter, [makeLogRecord()]);
    expect(result.code).toBe(ExportResultCode.FAILED);
    await exporter.shutdown();
  });

  it('metric exporter survives a non-string path', async function () {
    expect(() => new ServiceEventsCloudWatchMetricFileExporter(undefined as unknown as string)).not.toThrow();
    const exporter = new ServiceEventsCloudWatchMetricFileExporter(undefined as unknown as string);
    const emptyMetrics: ResourceMetrics = { resource: resourceFromAttributes({}), scopeMetrics: [] };
    const result = await awaitExport(exporter, emptyMetrics);
    expect(result.code).toBe(ExportResultCode.FAILED);
    await exporter.shutdown();
  });
});
