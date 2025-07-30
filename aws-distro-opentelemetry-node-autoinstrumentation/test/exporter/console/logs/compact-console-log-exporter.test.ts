// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import * as sinon from 'sinon';
import { ExportResultCode } from '@opentelemetry/core';
import { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { Resource } from '@opentelemetry/resources';
import { CompactConsoleLogRecordExporter } from '../../../../src/exporter/console/logs/compact-console-log-exporter';
import { Attributes } from '@opentelemetry/api';

describe('CompactConsoleLogRecordExporter', () => {
  let exporter: CompactConsoleLogRecordExporter;
  let stdoutWriteSpy: sinon.SinonSpy;

  const createMockLogRecord = (body: string, attributes: Attributes = {}): ReadableLogRecord => ({
    hrTime: [1640995200, 0],
    hrTimeObserved: [1640995200, 0],
    body,
    severityText: 'INFO',
    attributes,
    resource: Resource.empty(),
    instrumentationScope: { name: 'test', version: '1.0.0' },
    droppedAttributesCount: 0,
  });

  beforeEach(() => {
    exporter = new CompactConsoleLogRecordExporter();
    stdoutWriteSpy = sinon.spy(process.stdout, 'write');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should export logs and call callback with success', done => {
    const mockLogRecord = createMockLogRecord('test log message');
    const logs = [mockLogRecord];

    exporter.export(logs, result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(stdoutWriteSpy.calledOnce).toBeTruthy();

      const writtenData = stdoutWriteSpy.firstCall.args[0];
      expect(typeof writtenData).toBe('string');
      expect(writtenData.endsWith('\n')).toBeTruthy();

      const loggedContent = JSON.parse(writtenData.trim());
      expect(loggedContent.body).toBe('test log message');
      expect(loggedContent.severityText).toBe('INFO');
      expect(loggedContent.instrumentationScope.name).toBe('test');
      expect(loggedContent.instrumentationScope.version).toBe('1.0.0');

      done();
    });
  });

  it('should export multiple logs', done => {
    const mockLogRecords = [createMockLogRecord('log 1'), createMockLogRecord('log 2')];

    exporter.export(mockLogRecords, result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(stdoutWriteSpy.callCount).toBe(2);

      const firstLogContent = JSON.parse(stdoutWriteSpy.firstCall.args[0].trim());
      const secondLogContent = JSON.parse(stdoutWriteSpy.secondCall.args[0].trim());

      expect(firstLogContent.body).toBe('log 1');
      expect(secondLogContent.body).toBe('log 2');

      done();
    });
  });

  it('should handle empty logs array', done => {
    exporter.export([], result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(stdoutWriteSpy.called).toBeFalsy();
      done();
    });
  });

  it('should work without callback', () => {
    const mockLogRecord = createMockLogRecord('test log message');

    expect(() => {
      exporter.export([mockLogRecord], () => {});
    }).not.toThrow();
    expect(stdoutWriteSpy.calledOnce).toBeTruthy();

    const loggedContent = JSON.parse(stdoutWriteSpy.firstCall.args[0].trim());
    expect(loggedContent.body).toBe('test log message');
  });

  it('should handle undefined callback gracefully', () => {
    const mockLogRecord = createMockLogRecord('test log message');

    expect(() => {
      exporter['_sendLogRecordsToLambdaConsole']([mockLogRecord]);
    }).not.toThrow();
    expect(stdoutWriteSpy.calledOnce).toBeTruthy();

    const loggedContent = JSON.parse(stdoutWriteSpy.firstCall.args[0].trim());
    expect(loggedContent.body).toBe('test log message');
  });

  it('should format log record with all expected fields', done => {
    const mockLogRecord = createMockLogRecord('detailed test message', {
      customKey: 'customValue',
      requestId: '12345',
    });

    exporter.export([mockLogRecord], result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);

      const writtenData = stdoutWriteSpy.firstCall.args[0];
      const loggedContent = JSON.parse(writtenData.trim());
      expect(loggedContent.body).toBe('detailed test message');
      expect(loggedContent.severityText).toBe('INFO');
      expect(loggedContent.instrumentationScope.name).toBe('test');
      expect(loggedContent.instrumentationScope.version).toBe('1.0.0');
      expect(loggedContent.attributes).toEqual({ customKey: 'customValue', requestId: '12345' });

      done();
    });
  });
});
