// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as sinon from 'sinon';
import { AnyValue, SeverityNumber, LogRecord } from '@opentelemetry/api-logs';
import {
  AwsCloudWatchOtlpBatchLogRecordProcessor,
  BASE_LOG_BUFFER_BYTE_SIZE,
  MAX_LOG_REQUEST_BYTE_SIZE,
} from '../../../../../src/exporter/otlp/aws/logs/aws-cw-otlp-batch-log-record-processor';
import { OTLPAwsLogExporter } from '../../../../../src/exporter/otlp/aws/logs/otlp-aws-log-exporter';
import expect from 'expect';
import { ExportResultCode } from '@opentelemetry/core';

describe('AwsCloudWatchOtlpBatchLogRecordProcessor', () => {
  describe('estimateLogSize', () => {
    it('should handle nested structures (object/array)', () => {
      const logBody = 'X'.repeat(400);
      const logKey = 'test';
      const logDepth = 2;

      const nestedObjectLog = generateTestLogData(logBody, logKey, logDepth, 1, true)[0];
      const nestedArrayLog = generateTestLogData(logBody, logKey, logDepth, 1, false)[0];

      const expectedObjectSize = logKey.length * logDepth + logBody.length + BASE_LOG_BUFFER_BYTE_SIZE;
      const expectedArraySize = logBody.length + BASE_LOG_BUFFER_BYTE_SIZE;

      const actualObjectSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(
        nestedObjectLog,
        logDepth
      );
      const actualArraySize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(
        nestedArrayLog,
        logDepth
      );

      expect(actualObjectSize).toBe(expectedObjectSize);
      expect(actualArraySize).toBe(expectedArraySize);
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

      const expectedSize = logBody.length + attrKey.length + attrValue.length + BASE_LOG_BUFFER_BYTE_SIZE;
      const actualSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(record);

      expect(actualSize).toBe(expectedSize);
    });

    it('should cut off calculation for nested structure that exceeds depth limit', () => {
      const maxDepth = 0;
      const calculatedBody = 'X'.repeat(400);
      const logBody = {
        calculated: 'X'.repeat(400),
        thisDataWillNotBeIncludedInSizeCalculation: {
          truncated: {
            test: 'X'.repeat(MAX_LOG_REQUEST_BYTE_SIZE),
          },
        },
      };

      const expectedSize =
        BASE_LOG_BUFFER_BYTE_SIZE +
        'calculated'.length +
        calculatedBody.length +
        'thisDataWillNotBeIncludedInSizeCalculation'.length;

      const testLogs = generateTestLogData(logBody, 'key', 0, 1, true);
      const objectSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(testLogs[0], maxDepth);

      expect(objectSize).toBe(expectedSize);
    });

    it('should return prematurely if size exceeds MAX_LOG_REQUEST_BYTE_SIZE', () => {
      const logBody = {
        bigKey: 'X'.repeat(MAX_LOG_REQUEST_BYTE_SIZE),
        biggerKey: 'X'.repeat(MAX_LOG_REQUEST_BYTE_SIZE * 100),
      };

      const expectedSize = BASE_LOG_BUFFER_BYTE_SIZE + MAX_LOG_REQUEST_BYTE_SIZE + 'bigKey'.length + 'biggerKey'.length;

      const nestObjectLog = generateTestLogData(logBody, 'key', 0, 1, true);
      const nestArrayLog = generateTestLogData(logBody, 'key', 0, 1, false);

      const actualObjectSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(nestObjectLog[0]);
      const actualArraySize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(nestArrayLog[0]);

      expect(actualObjectSize).toBe(expectedSize);
      expect(actualArraySize).toBe(expectedSize);
    });

    it('should handle primitive types', () => {
      const primitives: AnyValue[] = [
        'test',
        new Uint8Array([116, 101, 115, 116]),
        1,
        1.2,
        true,
        false,
        null,
        '深入 Python',
        'calfé',
      ];
      const expectedSizes = [4, 4, 1, 3, 4, 5, 0, 2 * 4 + ' Python'.length, 1 * 4 + 'calf'.length];

      primitives.forEach((primitive, index) => {
        const log = generateTestLogData(primitive, 'key', 0, 1, true);
        const expectedSize = BASE_LOG_BUFFER_BYTE_SIZE + expectedSizes[index];
        const actualSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(log[0]);
        expect(actualSize).toBe(expectedSize);
      });
    });

    it('should handle circular references only once', () => {
      const cyclicObject: any = { data: 'test' };
      const cyclicArray: any = ['test'];
      cyclicObject.self_ref = cyclicObject;
      cyclicArray.push(cyclicArray);

      const objectLog = generateTestLogData(cyclicObject, 'key', 0, 1, true);
      const expectedObjectSize = BASE_LOG_BUFFER_BYTE_SIZE + 'data'.length + 'self_ref'.length + 'test'.length;
      const actualObjectSize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(objectLog[0]);

      const arrayLog = generateTestLogData(cyclicArray, 'key', 0, 1, true);
      const expectedArraySize = BASE_LOG_BUFFER_BYTE_SIZE + 'test'.length;
      const actualArraySize = (AwsCloudWatchOtlpBatchLogRecordProcessor as any).estimateLogSize(arrayLog[0]);

      expect(expectedObjectSize).toBe(actualObjectSize);
      expect(expectedArraySize).toBe(actualArraySize);
    });
  });

  describe('_flushSizeLimitedBatch', () => {
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
      processor._clearTimer = sandbox.stub();
      processor._export = sandbox.stub().resolves();
    });

    afterEach(() => sandbox.restore());

    it('should export single batch under size limit', async () => {
      const logCount = 10;
      const logBody = 'test';
      const testLogs = generateTestLogData(logBody, 'key', 0, logCount, true);
      processor._finishedLogRecords = testLogs;

      await (processor as AwsCloudWatchOtlpBatchLogRecordProcessor).forceFlush();

      expect(processor._finishedLogRecords.length).toBe(0);
      expect(processor._export.callCount).toBe(1);

      const exportedLogs = processor._export.getCall(0).args[0];
      expect(exportedLogs.length).toBe(logCount);
      exportedLogs.forEach((log: LogRecord) => {
        expect(log.body).toBe(logBody);
      });
    });

    it('should make multiple export calls for logs over size limit', async () => {
      const largeLogBody = 'X'.repeat(1048577); // > 1MB
      const logCount = 10;
      const testLogs = generateTestLogData(largeLogBody, 'key', 0, logCount, true);

      processor._finishedLogRecords = testLogs;

      await (processor as AwsCloudWatchOtlpBatchLogRecordProcessor).forceFlush();

      expect(processor._finishedLogRecords.length).toBe(0);
      expect(processor._export.callCount).toBe(logCount);

      processor._export.getCalls().forEach((call: any) => {
        expect(call.args.length).toBe(1);
        const logBatch = call.args[0];
        expect(logBatch.length).toBe(1);
      });
    });

    it('should handle mixed log sizes', async () => {
      const largeLogBody = 'X'.repeat(1048577); // > 1MB
      const smallLogBody = 'X'.repeat(Math.floor(1048576 / 10) - BASE_LOG_BUFFER_BYTE_SIZE); // Small log

      const largeLogs = generateTestLogData(largeLogBody, 'key', 0, 3, true);
      const smallLogs = generateTestLogData(smallLogBody, 'key', 0, 12, true);

      // 15 total logs. First 3 logs are oversized, next 12 logs are about 1/10 the size of a MB.
      // We should expect a total of 5 exports, the first 3 exports should be of batch size 1 containing just a single oversized log,
      // the next export should contain 10 logs each of which are 1/10 MB,
      // the last export should contain 2 logs each of which are 1/10 MB
      const testLogs = [...largeLogs, ...smallLogs];

      processor._finishedLogRecords = testLogs;

      await (processor as AwsCloudWatchOtlpBatchLogRecordProcessor).forceFlush();

      expect(processor._finishedLogRecords.length).toBe(0);
      expect(processor._export.callCount).toBe(5);

      const calls = processor._export.getCalls();
      const expectedBatchSizes = [1, 1, 1, 10, 2];

      calls.forEach((call: any, index: number) => {
        expect(call.args[0].length).toBe(expectedBatchSizes[index]);
      });
    });
  });

  function generateTestLogData(
    logBody: AnyValue,
    logKey: string = 'key',
    logBodyDepth: number = 0,
    count: number = 1,
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
