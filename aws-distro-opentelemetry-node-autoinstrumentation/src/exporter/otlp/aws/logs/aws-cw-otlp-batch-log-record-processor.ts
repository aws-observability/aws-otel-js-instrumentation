// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { SdkLogRecord, BufferConfig } from '@opentelemetry/sdk-logs';
import { AnyValue } from '@opentelemetry/api-logs';
import { ExportResultCode, globalErrorHandler } from '@opentelemetry/core';
import { OTLPAwsLogExporter } from './otlp-aws-log-exporter';

/*
 * OTel log events include fixed metadata attributes so the estimated metadata size
 * possibly be calculated as this with best efforts:
 * service.name (255 chars) + cloud.resource_id (max ARN length) + telemetry.xxx (~20 chars) +
 * common attributes (255 chars) +
 * scope + flags + traceId + spanId + numeric/timestamp fields + ...
 * Example log structure:
 * {
 *     "resource": {
 *         "attributes": {
 *             "aws.local.service": "example-service123",
 *             "telemetry.sdk.language": "python",
 *             "service.name": "my-application",
 *             "cloud.resource_id": "example-resource",
 *             "aws.log.group.names": "example-log-group",
 *             "aws.ai.agent.type": "default",
 *             "telemetry.sdk.version": "1.x.x",
 *             "telemetry.auto.version": "0.x.x",
 *             "telemetry.sdk.name": "opentelemetry"
 *         }
 *     },
 *     "scope": {"name": "example.instrumentation.library"},
 *     "timeUnixNano": 1234567890123456789,
 *     "observedTimeUnixNano": 1234567890987654321,
 *     "severityNumber": 9,
 *     "body": {...},
 *     "attributes": {...},
 *     "flags": 1,
 *     "traceId": "abcd1234efgh5678ijkl9012mnop3456",
 *     "spanId": "1234abcd5678efgh"
 * }
 * 2000 might be a bit of an overestimate but it's better to overestimate the size of the log
 * and suffer a small performance impact with batching than it is to underestimate and risk
 * a large log being dropped when sent to the AWS otlp endpoint.
 */
export const BASE_LOG_BUFFER_BYTE_SIZE: number = 2000;

// Maximum uncompressed/unserialized bytes / request -
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html
export const MAX_LOG_REQUEST_BYTE_SIZE: number = 1048576;

/**
 * Custom implementation of BatchLogRecordProcessor that manages log record batching
 * with size-based constraints to prevent exceeding AWS CloudWatch Logs OTLP endpoint request size limits.
 *
 * This processor still exports all logs up to _MAX_LOG_REQUEST_BYTE_SIZE but rather than doing exactly
 * one export, we will estimate log sizes and do multiple batch exports
 * where each exported batch will have an additional constraint:
 *
 * If the batch to be exported will have a data size of > 1 MB:
 * The batch will be split into multiple exports of sub-batches of data size <= 1 MB.
 *
 * A unique case is if the sub-batch is of data size > 1 MB, then the sub-batch will have exactly 1 log in it.
 *
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
export class AwsCloudWatchOtlpBatchLogRecordProcessor extends BatchLogRecordProcessor {
  constructor(exporter: OTLPAwsLogExporter, config?: BufferConfig) {
    super(exporter, config);
  }

  /**
   * Overrides upstream _flushAll method to add AWS CloudWatch size-based batching.
   * Drains all buffered log records (matching upstream _flushAll semantics) and exports
   * them sequentially in _maxExportBatchSize chunks. Within each chunk, sub-batches are
   * created to stay at or under the 1 MB CloudWatch Logs OTLP endpoint limit.
   *
   * Estimated data size of exported sub-batches will typically be <= 1 MB except for the case below:
   * If the estimated data size of an exported sub-batch is ever > 1 MB then the batch size is guaranteed to be 1
   */
  override async _flushAll(): Promise<void> {
    this['_clearTimer']();

    if (this['_finishedLogRecords'].length === 0) {
      return;
    }

    // Drain all buffered records, matching upstream _flushAll semantics.
    let toFlush: SdkLogRecord[] = this['_finishedLogRecords'];
    this['_finishedLogRecords'] = [];

    // Process in _maxExportBatchSize chunks sequentially, matching upstream back-pressure behavior.
    while (toFlush.length > 0) {
      let chunk: SdkLogRecord[];
      if (toFlush.length <= this['_maxExportBatchSize']) {
        chunk = toFlush;
        toFlush = [];
      } else {
        chunk = toFlush.splice(0, this['_maxExportBatchSize']);
      }

      // Within each chunk, apply size-based sub-batching for CloudWatch's 1 MB limit.
      const subBatches: SdkLogRecord[][] = [];
      let batch: SdkLogRecord[] = [];
      let batchDataSize = 0;

      for (const logData of chunk) {
        const logSize = AwsCloudWatchOtlpBatchLogRecordProcessor.estimateLogSize(logData);

        if (batch.length > 0 && batchDataSize + logSize > MAX_LOG_REQUEST_BYTE_SIZE) {
          subBatches.push(batch);
          batchDataSize = 0;
          batch = [];
        }

        batchDataSize += logSize;
        batch.push(logData);
      }

      if (batch.length > 0) {
        subBatches.push(batch);
      }

      // Export sub-batches sequentially to maintain back-pressure.
      for (const subBatch of subBatches) {
        try {
          await this._exportBatch(subBatch);
        } catch (e) {
          globalErrorHandler(e instanceof Error ? e : new Error(String(e)));
        }
      }
    }
  }

  /**
   * Exports a batch of log records using the exporter with a timeout.
   */
  private _exportBatch(batch: SdkLogRecord[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timeout'));
      }, this['_exportTimeoutMillis']);

      this['_exporter'].export(batch, (result: { code: number }) => {
        clearTimeout(timer);
        if (result.code === ExportResultCode.SUCCESS) {
          resolve();
        } else {
          reject(new Error('BatchLogRecordProcessor: log record export failed'));
        }
      });
    });
  }

  /**
   * Overrides upstream _exportOneBatch to add AWS CloudWatch size-based batching
   * on the timer-based periodic flush path.
   */
  override _exportOneBatch(): void {
    this['_clearTimer']();
    const logRecords: SdkLogRecord[] | null = this['_extractBatch']();
    if (logRecords === null) {
      return;
    }

    const batches: SdkLogRecord[][] = [];
    let batch: SdkLogRecord[] = [];
    let batchDataSize = 0;

    for (const logData of logRecords) {
      const logSize = AwsCloudWatchOtlpBatchLogRecordProcessor.estimateLogSize(logData);

      if (batch.length > 0 && batchDataSize + logSize > MAX_LOG_REQUEST_BYTE_SIZE) {
        batches.push(batch);
        batchDataSize = 0;
        batch = [];
      }

      batchDataSize += logSize;
      batch.push(logData);
    }

    if (batch.length > 0) {
      batches.push(batch);
    }

    // Export all sub-batches, replicating the base class bookkeeping
    const exportAll = async () => {
      for (const subBatch of batches) {
        try {
          await this._exportBatch(subBatch);
        } catch (e) {
          globalErrorHandler(e instanceof Error ? e : new Error(String(e)));
        }
      }
    };

    const exportPromise = exportAll();
    this['_currentExport'] = { exportCompleted: exportPromise, exportScheduled: Promise.resolve() };

    exportPromise
      .then(() => {
        this['_currentExport'] = null;
        this['_maybeStartTimer']();
      })
      .catch((error: Error) => {
        this['_currentExport'] = null;
        globalErrorHandler(error);
        this['_maybeStartTimer']();
      });
  }

  /**
   * Estimates the size in bytes of a log by calculating the size of its body and its attributes
   * and adding a buffer amount to account for other log metadata information.
   * Will process complex log structures up to the specified depth limit.
   * Includes cycle detection to prevent processing the log content more than once.
   * If the depth limit of the log structure is exceeded, returns the truncated calculation
   * to everything up to that point.
   *
   * We set depth to 3 as this is the minimum required depth to estimate our consolidated Gen AI log events:
   *
   * Example structure:
   * {
   *     "output": {
   *         "messages": [
   *             {
   *                 "content": "Hello, World!",
   *                 "role": "assistant"
   *             }
   *         ]
   *     },
   *     "input": {
   *         "messages": [
   *             {
   *                 "content": "Say Hello, World!",
   *                 "role": "user"
   *             }
   *         ]
   *     }
   * }
   *
   * @param log - The Log object to calculate size for
   * @param depth - Maximum depth to traverse in nested structures (default: 3)
   * @returns The estimated size of the log object in bytes
   */
  private static estimateLogSize(log: SdkLogRecord, maxDepth: number = 3): number {
    // Queue contains tuples of [log_content, depth] where:
    // - log_content is the current piece of log data being processed
    // - depth tracks how many levels deep we've traversed to reach this content
    // - body starts at depth 0 since it's an AnyValue object
    // - Attributes start at depth -1 since it's a Mapping[str, AnyValue] - when traversed, we will
    //   start processing its keys at depth 0
    let queue: Array<[AnyValue, number]> = [
      [log.body, 0],
      [log.attributes, -1],
    ];

    // Track visited complex log contents to avoid calculating the same one more than once
    const visited = new Set<object>();

    let size: number = BASE_LOG_BUFFER_BYTE_SIZE;

    while (queue.length > 0) {
      const newQueue: Array<[AnyValue, number]> = [];

      for (const [nextVal, currentDepth] of queue) {
        // Small optimization, can stop calculating the size once it reaches the 1 MB limit
        if (size >= MAX_LOG_REQUEST_BYTE_SIZE) {
          return size;
        }

        if (nextVal == null) {
          continue;
        }

        if (typeof nextVal === 'number' || typeof nextVal === 'boolean' || typeof nextVal === 'string') {
          size += this.estimateUtf8Size(nextVal.toString());
          continue;
        }

        if (nextVal instanceof Uint8Array) {
          size += nextVal.byteLength;
          continue;
        }

        // nextVal must be Array or AnyValueMap
        if (currentDepth <= maxDepth && !visited.has(nextVal)) {
          visited.add(nextVal);

          if (Array.isArray(nextVal)) {
            for (const content of nextVal) {
              newQueue.push([content, currentDepth + 1]);
            }
            continue;
          }
          if (typeof nextVal === 'object') {
            for (const key in nextVal) {
              size += AwsCloudWatchOtlpBatchLogRecordProcessor.estimateUtf8Size(key);
              newQueue.push([nextVal[key], currentDepth + 1]);
            }
          }
        }
      }
      queue = newQueue;
    }
    return size;
  }

  private static estimateUtf8Size(s: string): number {
    let asciiCount = 0;
    let nonAsciiCount = 0;

    for (const char of s) {
      if (char.charCodeAt(0) < 128) {
        asciiCount += 1;
      } else {
        nonAsciiCount += 1;
      }
    }

    return asciiCount + nonAsciiCount * 4;
  }
}
