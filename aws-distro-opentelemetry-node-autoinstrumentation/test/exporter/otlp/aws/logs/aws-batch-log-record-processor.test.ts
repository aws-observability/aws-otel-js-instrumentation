// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as sinon from 'sinon';
import {
  MAX_LOG_REQUEST_BYTE_SIZE,
  AwsBatchLogRecordProcessor,
  BASE_LOG_BUFFER_BYTE_SIZE,
} from '../../../../../src/exporter/otlp/aws/logs/aws-batch-log-record-processor';
import { LogRecord } from '@opentelemetry/sdk-logs';
import { AnyValue, SeverityNumber, LogRecord as apiLogRecord } from '@opentelemetry/api-logs';
import { DEFAULT_ATTRIBUTE_COUNT_LIMIT, ExportResultCode } from '@opentelemetry/core';
import { LoggerProviderSharedState } from '@opentelemetry/sdk-logs/build/src/internal/LoggerProviderSharedState';
import expect from 'expect';
import { IResource } from '@opentelemetry/resources';

describe('AwsBatchLogRecordProcessor', () => {
  let mockExporter: any;
  let processor: AwsBatchLogRecordProcessor;

  beforeEach(() => {
    mockExporter = {
      export: sinon.stub().callsFake((logs, resultCallback) => {
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }),
      setGenAIFlag: sinon.stub().callsFake(() => {
        return;
      }),
      shutdown: sinon.stub().callsFake(() => {
        return;
      })
    };

    processor = new AwsBatchLogRecordProcessor(mockExporter);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('_flushOneBatch', () => {
    it('should export single batch if under size limit', async () => {
      const logLength = 10;
      const testLogs = generateTestLogData(logLength);

      // Add logs to the processor queue
      for (const log of testLogs) {
        processor.onEmit(log);
      }

      await (processor as any)._flushOneBatch();

      expect((processor as any)._finishedLogRecords.length).toBe(0);
      expect(mockExporter.export.callCount).toBe(1);

      const exportedBatch = mockExporter.export.getCalls()[0].args[0];

      expect(exportedBatch.length).toBe(logLength);
      expect(mockExporter.setGenAIFlag.callCount).toBe(0);
    });

    it('should make multiple export calls of batch size 1 to export logs of size > 1 MB', async () => {
      const logLength = 10;
      const largeLogBody = {
        content: 'test'.repeat(MAX_LOG_REQUEST_BYTE_SIZE + 1),
        test: 'test',
      };
      const testLogs = generateTestLogData(logLength, largeLogBody);

      // Add logs to the processor queue
      for (const log of testLogs) {
        processor.onEmit(log);
      }

      await (processor as any)._flushOneBatch();

      expect((processor as any)._finishedLogRecords.length).toBe(0);
      expect(mockExporter.export.callCount).toBe(logLength);

      const exportCalls = mockExporter.export.getCalls();

      for (let i = 0; i < exportCalls.length; i += 1) {
        const batch = exportCalls[i].args[0];
        expect(batch.length).toBe(1);
      }

      expect(mockExporter.setGenAIFlag.callCount).toBe(10);
    });

    it('should correctly batch logs of mixed sizes with appropriate export calls', async () => {
      const largeLogBody = {
        content: 'test'.repeat(MAX_LOG_REQUEST_BYTE_SIZE + 1),
        test: 'test',
      };
      const oneTenthSizeLogBody = [
        'a'.repeat((MAX_LOG_REQUEST_BYTE_SIZE / 10) - BASE_LOG_BUFFER_BYTE_SIZE),
      ];

      // expect a total of 5 export calls:

      // 1st, 2nd, 3rd batch = export of batch size 1
      // 4th batch = export of batch size 10
      // 5th batch = export of batch size 2

      const expectedBatchLength: Record<number, number> = {
        0: 1, // 1st batch should have 1 log
        1: 1, // 2nd batch should have 1 log
        2: 1, // 3rd batch should have 1 log
        3: 10, // 4th batch should have 10 logs
        4: 2, // 5th batch should have 2 logs
      };
      const testLogs = generateTestLogData(3, largeLogBody).concat(generateTestLogData(12, oneTenthSizeLogBody));

      for (const log of testLogs) {
        processor.onEmit(log);
      }

      await (processor as any)._flushOneBatch();

      expect((processor as any)._finishedLogRecords.length).toBe(0);
      expect(mockExporter.export.callCount).toBe(5);

      const exportCalls = mockExporter.export.getCalls();

      for (let i = 0; i < exportCalls.length; i += 1) {
        const batch = exportCalls[i].args[0];
        expect(batch.length).toBe(expectedBatchLength[i]);
      }

      expect(mockExporter.setGenAIFlag.callCount).toBe(3);
    });
  });

  function generateTestLogData(count: number = 1, body?: AnyValue): LogRecord[] {
    const logs: LogRecord[] = [];

    for (let i = 0; i < count; i++) {
      const sharedState: LoggerProviderSharedState = {
        resource: {} as IResource,
        forceFlushTimeoutMillis: 10000,
        logRecordLimits: {
          attributeValueLengthLimit: DEFAULT_ATTRIBUTE_COUNT_LIMIT,
          attributeCountLimit: DEFAULT_ATTRIBUTE_COUNT_LIMIT,
        },
        loggers: new Map(),
        activeProcessor: processor,
        registeredLogRecordProcessors: [],
      };

      const logRecord: apiLogRecord = {
        timestamp: Date.now(),
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: body ? body : `Test log message ${i}`,
        attributes: { 'test.attribute': i },
      };

      const log = new LogRecord(sharedState, { name: 'test-scope', version: '1.0.0' }, logRecord);

      logs.push(log);
    }

    return logs;
  }
});
