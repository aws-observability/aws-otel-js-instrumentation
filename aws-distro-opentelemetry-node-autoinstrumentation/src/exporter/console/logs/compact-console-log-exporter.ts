// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ConsoleLogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';

export class CompactConsoleLogRecordExporter extends ConsoleLogRecordExporter {
  override export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this._sendLogRecordsToLambdaConsole(logs, resultCallback);
  }

  private _sendLogRecordsToLambdaConsole(logRecords: ReadableLogRecord[], done?: (result: ExportResult) => void): void {
    for (const logRecord of logRecords) {
      process.stdout.write(JSON.stringify(this['_exportInfo'](logRecord)) + '\n');
    }
    done?.({ code: ExportResultCode.SUCCESS });
  }
}
