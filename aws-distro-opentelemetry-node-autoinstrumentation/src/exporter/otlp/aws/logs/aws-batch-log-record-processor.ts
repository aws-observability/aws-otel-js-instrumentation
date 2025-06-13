// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LogRecord, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { AnyValue, AnyValueMap } from '@opentelemetry/api-logs';
import { callWithTimeout } from '@opentelemetry/core';
import type { BufferConfig } from '@opentelemetry/sdk-logs';
import { OTLPAwsLogExporter } from './otlp-aws-log-exporter';

export const BASE_LOG_BUFFER_BYTE_SIZE: number = 2000;
export const MAX_LOG_REQUEST_BYTE_SIZE: number = 1048576;

export class AwsBatchLogRecordProcessor extends BatchLogRecordProcessor {
  constructor(exporter: OTLPAwsLogExporter, config?: BufferConfig) {
    super(exporter, config);
    (this as any)._flushOneBatch = () => this._flushOneBatchIntermediary();
  }

  /**
   * Custom implementation of BatchLogRecordProcessor that manages log record batching
   * with size-based constraints to prevent exceeding AWS request size limits.
   *
   * This processor still exports all logs up to maxExportBatchSize but rather than doing exactly
   * one export promise, we do an array of export Promises where each exported batch will have an additonal constraint:
   *
   * If the batch to be exported will have a data size of > 1 MB:
   * The batch will be split into multiple exports of sub-batches of data size <= 1 MB.
   *
   * A unique case is if the sub-batch is of data size > 1 MB, then the sub-batch will have exactly 1 log in it.
   *
   */
  private _flushOneBatchIntermediary(): Promise<void> {
    const processor = this as any;

    processor._clearTimer();

    if (processor._finishedLogRecords.length === 0) {
      return Promise.resolve();
    }

    const logsToExport: LogRecord[] = processor._finishedLogRecords.splice(0, processor._maxExportBatchSize);
    let batch: LogRecord[] = [];
    let batchDataSize = 0;
    const exportPromises: Promise<void>[] = [];

    for (let i = 0; i < logsToExport.length; i += 1) {
      const logData = logsToExport[i];
      const logSize = AwsBatchLogRecordProcessor.getSizeOfLog(logData);

      if (batch.length > 0 && batchDataSize + logSize > MAX_LOG_REQUEST_BYTE_SIZE) {
        // if batchDataSize > MAX_LOG_REQUEST_BYTE_SIZE then batch.length == 1
        if (batchDataSize > MAX_LOG_REQUEST_BYTE_SIZE) {
          (processor._exporter as OTLPAwsLogExporter).setGenAIFlag();
        }

        exportPromises.push(callWithTimeout(processor._export(batch), processor._exportTimeoutMillis));
        batchDataSize = 0;
        batch = [];
      }

      batchDataSize += logSize;
      batch.push(logData);
    }

    if (batch.length > 0) {
      // if batchDataSize > MAX_LOG_REQUEST_BYTE_SIZE then batch.length == 1
      if (batchDataSize > MAX_LOG_REQUEST_BYTE_SIZE) {
        (processor._exporter as OTLPAwsLogExporter).setGenAIFlag();
      }

      exportPromises.push(callWithTimeout(processor._export(batch), processor._exportTimeoutMillis));
    }

    return new Promise((resolve, reject) => {
      Promise.all(exportPromises)
        .then(() => resolve())
        .catch(reject);
    });
  }

  /**
   * Calculates the estimated byte size of a log record.
   *
   * @param log - The LogRecord to calculate the size for
   * @returns The estimated size in bytes, including a base buffer size plus the size of the log body
   */
  private static getSizeOfLog(log: LogRecord): number {
    if (!log.body) {
      return BASE_LOG_BUFFER_BYTE_SIZE;
    }
    return BASE_LOG_BUFFER_BYTE_SIZE + AwsBatchLogRecordProcessor.getSizeOfAnyValue(log.body);
  }

  /**
   * Calculates the size of an AnyValue type. If AnyValue is an instance of a Map or Array, calculation is truncated to one layer.
   *
   * @param val - The AnyValue to calculate the size for
   * @returns The size in bytes
   */
  private static getSizeOfAnyValue(val: AnyValue): number {
    // Use a stack to prevent excessive recursive calls
    const stack: AnyValue[] = [val];
    let size: number = 0;
    let depth: number = 0;

    while (stack.length > 0) {
      const nextVal = stack.pop();

      if (!nextVal) {
        continue;
      }

      if (typeof nextVal === 'string') {
        size += nextVal.length;
        continue;
      }

      if (typeof nextVal === 'boolean') {
        size += nextVal ? 4 : 5; // 'true' or 'false'
        continue;
      }

      if (typeof nextVal === 'number') {
        size += nextVal.toString().length;
        continue;
      }

      if (nextVal instanceof Uint8Array) {
        size += nextVal.byteLength;
        continue;
      }

      if (depth < 1) {
        if (Array.isArray(nextVal)) {
          for (const item of nextVal) {
            stack.push(item);
          }

          // By process of elimination, nextVal has to be a Map
        } else {
          const map = nextVal as AnyValueMap;

          for (const key in map) {
            size += key.length;
            stack.push(map[key]);
          }
        }

        depth += 1;
        continue;
      }
    }

    return size;
  }
}
