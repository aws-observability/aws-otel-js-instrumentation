// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import { trace, TraceFlags } from '@opentelemetry/api';
import { LoggerProvider, SimpleLogRecordProcessor, InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { SnapshotOtlpEmitter } from '../../src/dynamic-instrumentation/snapshot-otlp-emitter';
import { Snapshot } from '../../src/dynamic-instrumentation/model/snapshot';

describe('SnapshotOtlpEmitter trace context', function () {
  let emitter: SnapshotOtlpEmitter;
  let inMemoryExporter: InMemoryLogRecordExporter;
  let loggerProvider: LoggerProvider;

  beforeEach(function () {
    inMemoryExporter = new InMemoryLogRecordExporter();
    loggerProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(inMemoryExporter)],
    });

    // Create emitter and inject the test logger provider
    emitter = new SnapshotOtlpEmitter('http://localhost:4321/v1/logs', 'test-service', 'test-env');
    // Override the internal logger with our in-memory one
    (emitter as any).logger = loggerProvider.getLogger('aws.dynamic_instrumentation', '1.0');
  });

  afterEach(async function () {
    await loggerProvider.shutdown();
    sinon.restore();
  });

  function buildSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
    return {
      id: 'snap-123',
      timestamp: Date.now(),
      service: 'test-service',
      environment: 'test-env',
      locationHash: 'hash-abc',
      instrumentation: {
        location: {
          lineNumber: 42,
          filePath: '/app/test.js',
          language: 'javascript',
        },
      },
      trace: { traceId: '', spanId: '' },
      thread: { id: 0, name: 'main' },
      stack: [],
      captures: { lines: { '42': { locals: {} } } },
      ...overrides,
    };
  }

  it('should set top-level traceId and spanId on log record when trace context is present', function () {
    const traceId = 'abcdef1234567890abcdef1234567890';
    const spanId = '1234567890abcdef';

    const snapshot = buildSnapshot({
      trace: { traceId, spanId },
    });

    emitter.emitSnapshot(snapshot, 'BREAKPOINT');

    const records = inMemoryExporter.getFinishedLogRecords();
    expect(records.length).toBe(1);
    expect(records[0].spanContext?.traceId).toBe(traceId);
    expect(records[0].spanContext?.spanId).toBe(spanId);
    expect(records[0].spanContext?.traceFlags).toBe(TraceFlags.SAMPLED);
  });

  it('should not set spanContext when trace fields are empty', function () {
    const snapshot = buildSnapshot({
      trace: { traceId: '', spanId: '' },
    });

    emitter.emitSnapshot(snapshot, 'BREAKPOINT');

    const records = inMemoryExporter.getFinishedLogRecords();
    expect(records.length).toBe(1);
    expect(records[0].spanContext).toBeUndefined();
  });

  it('should not set spanContext when only traceId is present', function () {
    const snapshot = buildSnapshot({
      trace: { traceId: 'abcdef1234567890abcdef1234567890', spanId: '' },
    });

    emitter.emitSnapshot(snapshot, 'BREAKPOINT');

    const records = inMemoryExporter.getFinishedLogRecords();
    expect(records.length).toBe(1);
    expect(records[0].spanContext).toBeUndefined();
  });

  it('should not set spanContext when only spanId is present', function () {
    const snapshot = buildSnapshot({
      trace: { traceId: '', spanId: '1234567890abcdef' },
    });

    emitter.emitSnapshot(snapshot, 'BREAKPOINT');

    const records = inMemoryExporter.getFinishedLogRecords();
    expect(records.length).toBe(1);
    expect(records[0].spanContext).toBeUndefined();
  });

  it('should not set spanContext when trace object is missing', function () {
    const snapshot = buildSnapshot();
    (snapshot as any).trace = undefined;

    emitter.emitSnapshot(snapshot, 'BREAKPOINT');

    const records = inMemoryExporter.getFinishedLogRecords();
    expect(records.length).toBe(1);
    expect(records[0].spanContext).toBeUndefined();
  });

  it('should still emit snapshot when trace context construction throws', function () {
    const snapshot = buildSnapshot({
      trace: { traceId: 'abcdef1234567890abcdef1234567890', spanId: '1234567890abcdef' },
    });

    // Stub trace.setSpanContext to throw
    const stub = sinon.stub(trace, 'setSpanContext').throws(new Error('unexpected error'));

    emitter.emitSnapshot(snapshot, 'BREAKPOINT');

    const records = inMemoryExporter.getFinishedLogRecords();
    expect(records.length).toBe(1);
    // spanContext may or may not be set depending on where error occurs,
    // but the important thing is the snapshot was still emitted
    expect(records[0].attributes['aws.di.snapshot_id']).toBe('snap-123');

    stub.restore();
  });

  it('should preserve all other attributes when trace context is set', function () {
    const traceId = 'abcdef1234567890abcdef1234567890';
    const spanId = '1234567890abcdef';

    const snapshot = buildSnapshot({
      trace: { traceId, spanId },
    });

    emitter.emitSnapshot(snapshot, 'BREAKPOINT');

    const records = inMemoryExporter.getFinishedLogRecords();
    expect(records.length).toBe(1);
    const attrs = records[0].attributes;
    expect(attrs['aws.di.snapshot_id']).toBe('snap-123');
    expect(attrs['aws.di.location_hash']).toBe('hash-abc');
    expect(attrs['aws.di.file_path']).toBe('/app/test.js');
    expect(attrs['aws.di.line_number']).toBe(42);
    expect(attrs['aws.di.instrumentation_type']).toBe('BREAKPOINT');
  });
});
