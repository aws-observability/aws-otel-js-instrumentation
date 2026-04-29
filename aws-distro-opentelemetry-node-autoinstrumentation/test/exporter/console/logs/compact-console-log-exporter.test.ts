// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import * as sinon from 'sinon';
import { INVALID_TRACEID, INVALID_SPANID } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { ExportResultCode } from '@opentelemetry/core';
import { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { CompactConsoleLogRecordExporter } from '../../../../src/exporter/console/logs/compact-console-log-exporter';

describe('CompactConsoleLogRecordExporter', () => {
  let exporter: CompactConsoleLogRecordExporter;
  let stdoutWriteSpy: sinon.SinonSpy;

  const createMockLogRecord = (overrides: Partial<ReadableLogRecord> = {}): ReadableLogRecord => ({
    hrTime: [1000000000, 0],
    hrTimeObserved: [1000000000, 0],
    body: 'Test log message',
    severityText: 'INFO',
    severityNumber: SeverityNumber.INFO,
    attributes: { key: 'value' },
    resource: {
      attributes: { 'service.name': 'test-service' },
      schemaUrl: 'https://opentelemetry.io/schemas/1.0.0',
      merge: () => ({} as any),
      getRawAttributes: () => [],
    },
    instrumentationScope: {
      name: 'test-scope',
      version: '1.0.0',
      schemaUrl: 'https://opentelemetry.io/schemas/1.0.0',
    },
    droppedAttributesCount: 2,
    spanContext: {
      traceId: '12345678901234567890123456789012',
      spanId: '1234567890123456',
      traceFlags: 1,
      traceState: undefined as any,
      isRemote: false,
    },
    ...overrides,
  });

  beforeEach(() => {
    exporter = new CompactConsoleLogRecordExporter();
    stdoutWriteSpy = sinon.spy(process.stdout, 'write');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should export with all fields matching canonical schema', done => {
    const logRecord = createMockLogRecord();

    exporter.export([logRecord], result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(stdoutWriteSpy.calledOnce).toBeTruthy();

      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);

      expect(parsed).toEqual({
        resource: {
          attributes: { 'service.name': 'test-service' },
          schemaUrl: 'https://opentelemetry.io/schemas/1.0.0',
        },
        scope: {
          name: 'test-scope',
          version: '1.0.0',
          schemaUrl: 'https://opentelemetry.io/schemas/1.0.0',
        },
        body: 'Test log message',
        severityNumber: 9,
        severityText: 'INFO',
        attributes: { key: 'value' },
        droppedAttributes: 2,
        timeUnixNano: '1000000000000000000',
        observedTimeUnixNano: '1000000000000000000',
        traceId: '12345678901234567890123456789012',
        spanId: '1234567890123456',
        flags: 1,
        exportPath: 'console',
      });

      done();
    });
  });

  it('should handle null body', done => {
    const logRecord = createMockLogRecord({ body: undefined });

    exporter.export([logRecord], result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.body).toBeNull();
      done();
    });
  });

  it('should handle zero timestamps', done => {
    const logRecord = createMockLogRecord({ hrTime: [0, 0], hrTimeObserved: [0, 0] });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.timeUnixNano).toBe('0');
      expect(parsed.observedTimeUnixNano).toBe('0');
      done();
    });
  });

  it('should output empty traceId/spanId for invalid span context (all zeros)', done => {
    const logRecord = createMockLogRecord({
      spanContext: {
        traceId: INVALID_TRACEID,
        spanId: INVALID_SPANID,
        traceFlags: 1,
        traceState: undefined as any,
        isRemote: false,
      },
    });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.traceId).toBe('');
      expect(parsed.spanId).toBe('');
      done();
    });
  });

  it('should output empty traceId/spanId for invalid traceId only', done => {
    const logRecord = createMockLogRecord({
      spanContext: {
        traceId: INVALID_TRACEID,
        spanId: '1234567890123456',
        traceFlags: 1,
        traceState: undefined as any,
        isRemote: false,
      },
    });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.traceId).toBe('');
      expect(parsed.spanId).toBe('');
      done();
    });
  });

  it('should output empty traceId/spanId when no span context', done => {
    const logRecord = createMockLogRecord({ spanContext: undefined });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.traceId).toBe('');
      expect(parsed.spanId).toBe('');
      expect(parsed.flags).toBe(0);
      done();
    });
  });

  it('should preserve attribute value types', done => {
    const logRecord = createMockLogRecord({ attributes: { count: 42, enabled: true, rate: 3.14, name: 'test' } });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.attributes.count).toBe(42);
      expect(parsed.attributes.enabled).toBe(true);
      expect(parsed.attributes.rate).toBe(3.14);
      expect(parsed.attributes.name).toBe('test');
      done();
    });
  });

  it('should handle empty attributes', done => {
    const logRecord = createMockLogRecord({ attributes: {} });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.attributes).toEqual({});
      done();
    });
  });

  it('should export multiple log records as separate lines', done => {
    const log1 = createMockLogRecord({ body: 'first' });
    const log2 = createMockLogRecord({ body: 'second' });

    exporter.export([log1, log2], result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(stdoutWriteSpy.callCount).toBe(2);
      expect(JSON.parse(stdoutWriteSpy.firstCall.args[0] as string).body).toBe('first');
      expect(JSON.parse(stdoutWriteSpy.secondCall.args[0] as string).body).toBe('second');
      done();
    });
  });

  it('should handle empty batch', done => {
    exporter.export([], result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(stdoutWriteSpy.called).toBeFalsy();
      done();
    });
  });

  it('should output raw epoch nanos for timestamp', done => {
    const logRecord = createMockLogRecord({ hrTime: [1000000000, 123000000] });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.timeUnixNano).toBe('1000000000123000000');
      done();
    });
  });

  it('should preserve full nanosecond precision', done => {
    const logRecord = createMockLogRecord({ hrTime: [1000000000, 100000000] });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.timeUnixNano).toBe('1000000000100000000');
      done();
    });
  });

  it('should map severity numbers to OTel spec names', done => {
    const cases: [SeverityNumber, string][] = [
      [SeverityNumber.TRACE, 'TRACE'],
      [SeverityNumber.DEBUG, 'DEBUG'],
      [SeverityNumber.INFO, 'INFO'],
      [SeverityNumber.WARN, 'WARN'],
      [SeverityNumber.ERROR, 'ERROR'],
      [SeverityNumber.FATAL, 'FATAL'],
    ];

    let completed = 0;
    for (const [sevNum, expectedText] of cases) {
      sinon.restore();
      stdoutWriteSpy = sinon.spy(process.stdout, 'write');
      const newExporter = new CompactConsoleLogRecordExporter();
      const logRecord = createMockLogRecord({ severityNumber: sevNum });

      newExporter.export([logRecord], result => {
        const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
        expect(parsed.severityText).toBe(expectedText);
        expect(parsed.severityNumber).toBe(sevNum);
        completed++;
        if (completed === cases.length) done();
      });
    }
  });

  it('should output compact single-line JSON', done => {
    const logRecord = createMockLogRecord();

    exporter.export([logRecord], result => {
      const output = (stdoutWriteSpy.firstCall.args[0] as string).trim();
      expect(output).not.toContain('\n');
      expect(output).not.toContain('  ');
      done();
    });
  });

  it('should return FAILED after shutdown', done => {
    exporter.shutdown().then(() => {
      exporter.export([createMockLogRecord()], result => {
        expect(result.code).toBe(ExportResultCode.FAILED);
        expect(stdoutWriteSpy.called).toBeFalsy();
        done();
      });
    });
  });

  it('should resolve forceFlush', async () => {
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
  });

  it('should fall back to ConsoleLogRecordExporter on serialization error', done => {
    const circular: any = {};
    circular.self = circular;
    const badRecord = createMockLogRecord({ attributes: circular });

    exporter.export([badRecord], result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      done();
    });
  });

  it('should output UNSPECIFIED for null severity number', done => {
    const logRecord = createMockLogRecord({ severityNumber: undefined as any });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.severityText).toBe('UNSPECIFIED');
      expect(parsed.severityNumber).toBe(0);
      done();
    });
  });

  it('should handle empty resource and scope', done => {
    const logRecord = createMockLogRecord({
      resource: {
        attributes: {},
        merge: () => ({} as any),
        getRawAttributes: () => [],
      },
      instrumentationScope: { name: '' },
    });

    exporter.export([logRecord], result => {
      const parsed = JSON.parse(stdoutWriteSpy.firstCall.args[0] as string);
      expect(parsed.resource.attributes).toEqual({});
      expect(parsed.resource.schemaUrl).toBe('');
      expect(parsed.scope.name).toBe('');
      expect(parsed.scope.version).toBe('');
      expect(parsed.scope.schemaUrl).toBe('');
      done();
    });
  });
});
