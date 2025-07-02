// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as sinon from 'sinon';
import { AnyValue, SeverityNumber, LogRecord } from '@opentelemetry/api-logs';
import {
  AwsCloudWatchOtlpBatchLogRecordProcessor,
  BASE_LOG_BUFFER_BYTE_SIZE,
  MAX_LOG_REQUEST_BYTE_SIZE,
} from '../../../../../src/exporter/otlp/aws/logs/aws-batch-log-record-processor';
import { OTLPAwsLogExporter } from '../../../../../src/exporter/otlp/aws/logs/otlp-aws-log-exporter';
import expect from 'expect';
import { ExportResultCode } from '@opentelemetry/core';

describe('AwsCloudWatchOtlpBatchLogRecordProcessor', () => {
  describe('estimateLogSize', () => {
    it('should handle nested structures (dict/array)', () => {
      const logBody = 'X'.repeat(400);
      const logKey = 'test';
      const logDepth = 2;

      const nestedDictLog = generateTestLogData(logBody, logKey, logDepth, 1, true)[0];
      const nestedArrayLog = generateTestLogData(logBody, logKey, logDepth, 1, false)[0];

      const expectedDictSize = logKey.length * logDepth + logBody.length;
      const expectedArraySize = logBody.length;

      const dictSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(nestedDictLog, logDepth);
      const arraySize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(nestedArrayLog, logDepth);

      expect(dictSize - BASE_LOG_BUFFER_BYTE_SIZE).toBe(expectedDictSize);
      expect(arraySize - BASE_LOG_BUFFER_BYTE_SIZE).toBe(expectedArraySize);
    });

    it('should handle both body and attributes', () => {
      const logBody = 'test_body';
      const attrKey = 'attr_key';
      const attrValue = 'attr_value';

      const record: LogRecord = {
        timestamp: Date.now(),
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: logBody,
        attributes: { [attrKey]: attrValue },
      };

      const expectedSize = logBody.length + attrKey.length + attrValue.length;
      const actualSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(record);

      expect(actualSize - BASE_LOG_BUFFER_BYTE_SIZE).toBe(expectedSize);
    });

    it('should cut off calculation for nested structure that exceeds depth limit', () => {
      const maxDepth = 0;
      const calculatedBody = 'X'.repeat(400);
      const logBody = {
        calculated: 'X'.repeat(400),
        restOfThisLogWillBeTruncated: {
          truncated: {
            test: 'X'.repeat(MAX_LOG_REQUEST_BYTE_SIZE),
          },
        },
      };

      const expectedSize =
        BASE_LOG_BUFFER_BYTE_SIZE + 'calculated'.length + calculatedBody.length + 'restOfThisLogWillBeTruncated'.length;

      const testLogs = generateTestLogData(logBody, 'key', 0, 1, true);
      const dictSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(testLogs[0], maxDepth);

      expect(dictSize).toBe(expectedSize);
    });

    it('should return prematurely if size exceeds MAX_LOG_REQUEST_BYTE_SIZE', () => {
      const logBody = {
        bigKey: 'X'.repeat(MAX_LOG_REQUEST_BYTE_SIZE),
        biggerKey: 'X'.repeat(MAX_LOG_REQUEST_BYTE_SIZE * 100),
      };

      const expectedSize = BASE_LOG_BUFFER_BYTE_SIZE + MAX_LOG_REQUEST_BYTE_SIZE + 'bigKey'.length + 'biggerKey'.length;

      const nestDictLog = generateTestLogData(logBody, 'key', 0, 1, true);
      const nestArrayLog = generateTestLogData(logBody, 'key', 0, 1, false);

      const dictSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(nestDictLog[0]);
      const arraySize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(nestArrayLog[0]);

      expect(dictSize).toBe(expectedSize);
      expect(arraySize).toBe(expectedSize);
    });

    it('should handle primitive types', () => {
      const primitives: AnyValue[] = ['test', new Uint8Array([116, 101, 115, 116]), 1, 1.2, true, false, null];
      const expectedSizes = [4, 4, 1, 3, 4, 5, 0];

      primitives.forEach((primitive, index) => {
        const log = generateTestLogData(primitive, 'key', 0, 1, true);
        const expectedSize = BASE_LOG_BUFFER_BYTE_SIZE + expectedSizes[index];
        const actualSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(log[0]);
        expect(actualSize).toBe(expectedSize);
      });
    });

    it('should handle circular references only once', () => {
      const cyclicDict: any = { data: 'test' };
      cyclicDict.self_ref = cyclicDict;

      const log = generateTestLogData(cyclicDict, 'key', 0, 1, true);
      const expectedSize = BASE_LOG_BUFFER_BYTE_SIZE + 'data'.length + 'self_ref'.length + 'test'.length;
      const actualSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(log[0]);

      expect(actualSize).toBe(expectedSize);
    });
  });

  describe('_flushOneBatchIntermediary', () => {
    let sandbox!: sinon.SinonSandbox;
    let mockExporter: sinon.SinonStubbedInstance<OTLPAwsLogExporter>;
    let processor: any; // Setting it to any instead of AwsCloudWatchOtlpBatchLogRecordProcessor since we need to stub a few of its methods

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      mockExporter = {
        export: sandbox.stub().resolves({ code: ExportResultCode.SUCCESS }),
      } as any;
      processor = new AwsCloudWatchOtlpBatchLogRecordProcessor(mockExporter, {
        maxExportBatchSize: 50,
        exportTimeoutMillis: 5000,
      });
      processor = processor._clearTimer = sinon.stub();
      processor._export = sandbox.stub().resolves();
    });

    afterEach(() => sandbox.restore());

    it('should export single batch under size limit', async () => {
      const logCount = 10;
      const logBody = 'test';
      const testLogs = generateTestLogData(logBody, 'key', 0, logCount, true);

      processor._finishedLogRecords = testLogs;

      await processor._flushOneBatchIntermediary();

      expect(processor._finishedLogRecords.length).toBe(0);
      expect(processor._export.callCount).toBe(1);
      expect(processor._export.calledWith(testLogs)).toBe(true);
    });

    // it('should make multiple export calls for logs over size limit', async () => {
    //   const largeLogBody = 'X'.repeat(1048577); // > 1MB
    //   const testLogs = generateTestLogData(largeLogBody, 'key', 0, 3, true);

    //   processorAny.parentProcessor._finishedLogRecords = testLogs;

    //   await processorAny._flushOneBatchIntermediary();

    //   expect(processorAny.parentProcessor._finishedLogRecords.length).toBe(0);
    //   expect(processorAny.parentProcessor._export.callCount).toBe(3);

    //   processorAny.parentProcessor._export.getCalls().forEach((call: any) => {
    //     expect(call.args[0].length).toBe(1);
    //   });
    // });

    // it('should handle mixed log sizes', async () => {
    //   const largeLogBody = 'X'.repeat(1048577); // > 1MB
    //   const smallLogBody = 'X'.repeat(Math.floor(1048576 / 10) - 2000); // Small log

    //   const largeLogs = generateTestLogData(largeLogBody, 'key', 0, 3, true);
    //   const smallLogs = generateTestLogData(smallLogBody, 'key', 0, 12, true);
    //   const testLogs = [...largeLogs, ...smallLogs];

    //   processorAny.parentProcessor._finishedLogRecords = testLogs;

    //   await processorAny._flushOneBatchIntermediary();

    //   expect(processorAny.parentProcessor._finishedLogRecords.length).toBe(0);
    //   expect(processorAny.parentProcessor._export.callCount).toBe(5);

    //   const calls = processorAny.parentProcessor._export.getCalls();
    //   const expectedSizes = [1, 1, 1, 10, 2];

    //   calls.forEach((call: any, index: number) => {
    //     expect(call.args[0].length).toBe(expectedSizes[index]);
    //   });
    // });
  });

  function generateTestLogData(
    logBody: AnyValue,
    logKey: string = 'key',
    logBodyDepth: number = 0,
    count: number = 5,
    createMap: boolean = true
  ): LogRecord[] {
    function generateNestedValue(depth: number, value: AnyValue, createMap: boolean = true): AnyValue {
      if (depth <= 0) {
        return value;
      }

      if (createMap) {
        return { [logKey]: generateNestedValue(depth - 1, value, true) };
      }

      return [generateNestedValue(depth - 1, value, false)];
    }

    const logs: LogRecord[] = [];

    for (let i = 0; i < count; i++) {
      const logRecord: LogRecord = {
        timestamp: Date.now(),
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: generateNestedValue(logBodyDepth, logBody, createMap),
        attributes: {},
      };

      logs.push(logRecord);
    }

    return logs;
  }
});
