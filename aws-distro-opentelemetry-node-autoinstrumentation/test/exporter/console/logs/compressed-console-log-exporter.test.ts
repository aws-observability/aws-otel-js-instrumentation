// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import * as sinon from 'sinon';
import { ExportResultCode } from '@opentelemetry/core';
import { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { Resource } from '@opentelemetry/resources';
import { CompressedConsoleLogRecordExporter } from '../../../../src/exporter/console/logs/compressed-console-log-exporter';
import { Attributes } from '@opentelemetry/api';

describe('CompressedConsoleLogRecordExporter', () => {
  let exporter: CompressedConsoleLogRecordExporter;
  let consoleLogSpy: sinon.SinonSpy;

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
    exporter = new CompressedConsoleLogRecordExporter();
    consoleLogSpy = sinon.spy(console, 'log');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should export logs and call callback with success', done => {
    const mockLogRecord = createMockLogRecord('test log message');
    const logs = [mockLogRecord];

    exporter.export(logs, result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(consoleLogSpy.calledOnce).toBeTruthy();

      const loggedContent = consoleLogSpy.firstCall.args[0];
      expect(typeof loggedContent).toBe('object');
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
      expect(consoleLogSpy.callCount).toBe(2);

      const firstLogContent = consoleLogSpy.firstCall.args[0];
      const secondLogContent = consoleLogSpy.secondCall.args[0];

      expect(firstLogContent.body).toBe('log 1');
      expect(secondLogContent.body).toBe('log 2');

      done();
    });
  });

  it('should handle empty logs array', done => {
    exporter.export([], result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(consoleLogSpy.called).toBeFalsy();
      done();
    });
  });

  it('should work without callback', () => {
    const mockLogRecord = createMockLogRecord('test log message');

    expect(() => {
      exporter.export([mockLogRecord], () => {});
    }).not.toThrow();
    expect(consoleLogSpy.calledOnce).toBeTruthy();

    const loggedContent = consoleLogSpy.firstCall.args[0];
    expect(loggedContent.body).toBe('test log message');
  });

  it('should handle undefined callback gracefully', () => {
    const mockLogRecord = createMockLogRecord('test log message');

    expect(() => {
      exporter['_sendLogRecordsToLambdaConsole']([mockLogRecord]);
    }).not.toThrow();
    expect(consoleLogSpy.calledOnce).toBeTruthy();

    const loggedContent = consoleLogSpy.firstCall.args[0];
    expect(loggedContent.body).toBe('test log message');
  });

  it('should format log record with all expected fields', done => {
    const mockLogRecord = createMockLogRecord('detailed test message', {
      customKey: 'customValue',
      requestId: '12345',
    });

    exporter.export([mockLogRecord], result => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);

      const loggedContent = consoleLogSpy.firstCall.args[0];
      expect(typeof loggedContent).toBe('object');
      expect(loggedContent.body).toBe('detailed test message');
      expect(loggedContent.severityText).toBe('INFO');
      expect(loggedContent.instrumentationScope.name).toBe('test');
      expect(loggedContent.instrumentationScope.version).toBe('1.0.0');
      expect(loggedContent.attributes).toEqual({ customKey: 'customValue', requestId: '12345' });

      done();
    });
  });
});
