// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  CloudWatchLogsClientConfig,
  PutLogEventsCommandInput,
  CloudWatchLogs as CloudWatchLogsType,
  LogEvent,
  PutLogEventsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import { context, diag } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import * as Crypto from 'crypto';

/**
 * Container for a batch of CloudWatch log events with metadata.
 */
export class LogEventBatch {
  public logEvents: Required<LogEvent>[] = [];
  public byteTotal: number = 0;
  public minTimestampMs: number = 0;
  public maxTimestampMs: number = 0;
  public createdTimestampMs: number;

  constructor() {
    this.createdTimestampMs = Date.now();
  }

  /**
   * Add a log event to the batch.
   *
   * @param logEvent The log event to add
   * @param eventSize The byte size of the event
   */
  addEvent(logEvent: Required<LogEvent>, eventSize: number): void {
    this.logEvents.push(logEvent);
    this.byteTotal += eventSize;

    // Update timestamp tracking
    const timestamp = logEvent.timestamp;
    if (this.minTimestampMs === 0 || timestamp < this.minTimestampMs) {
      this.minTimestampMs = timestamp;
    }
    if (timestamp > this.maxTimestampMs) {
      this.maxTimestampMs = timestamp;
    }
  }

  /**
   * Check if the batch is empty.
   *
   * @returns {boolean}
   */
  isEmpty(): boolean {
    return this.logEvents.length === 0;
  }

  /**
   * Get the number of events in the batch
   *
   * @returns {number}
   */
  size(): number {
    return this.logEvents.length;
  }

  clear(): void {
    this.logEvents = [];
    this.byteTotal = 0;
    this.minTimestampMs = 0;
    this.maxTimestampMs = 0;
    this.createdTimestampMs = Date.now();
  }
}

/**
 * CloudWatch Logs client for batching and sending log events.
 */
export class CloudWatchLogsClient {
  // Constants for CloudWatch Logs limits
  // http://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html
  // http://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutLogEvents.html
  static readonly CW_MAX_EVENT_PAYLOAD_BYTES: number = 256 * 1024; // 256KB
  static readonly CW_MAX_REQUEST_EVENT_COUNT: number = 10000;
  static readonly CW_PER_EVENT_HEADER_BYTES: number = 26;
  static readonly BATCH_FLUSH_INTERVAL: number = 60 * 1000;
  static readonly CW_MAX_REQUEST_PAYLOAD_BYTES: number = 1 * 1024 * 1024; // 1MB
  static readonly CW_TRUNCATED_SUFFIX: string = '[Truncated...]';
  // None of the log events in the batch can be older than 14 days
  static readonly CW_EVENT_TIMESTAMP_LIMIT_PAST: number = 14 * 24 * 60 * 60 * 1000;
  // None of the log events in the batch can be more than 2 hours in the future.
  static readonly CW_EVENT_TIMESTAMP_LIMIT_FUTURE: number = 2 * 60 * 60 * 1000;

  private logGroupName: string;
  private logStreamName: string;
  private logsClient: CloudWatchLogsType;
  private eventBatch?: LogEventBatch;

  constructor(logGroupName: string, logStreamName?: string, cloudwatchLogsConfig: CloudWatchLogsClientConfig = {}) {
    this.logGroupName = logGroupName;
    this.logStreamName = logStreamName || this.generateLogStreamName();
    // Require CloudWatchLogs Client during runtime so AWS SDK isn't
    // loaded before any OpenTelemetry patching is done on AWS SDK.
    const { CloudWatchLogs } = require('@aws-sdk/client-cloudwatch-logs');
    this.logsClient = new CloudWatchLogs(cloudwatchLogsConfig);
  }

  /**
   * Generate a unique log stream name.
   *
   * @returns {string}
   */
  private generateLogStreamName(): string {
    const uniqueId = Crypto.randomUUID().substring(0, 8);
    return `otel-js-${uniqueId}`;
  }

  /**
   * Ensure the log group exists, create if it doesn't.
   */
  private async ensureLogGroupExists(): Promise<void> {
    try {
      await context.with(suppressTracing(context.active()), async () => {
        await this.logsClient.createLogGroup({
          logGroupName: this.logGroupName,
        });
      });
      diag.info(`Created log group: ${this.logGroupName}`);
    } catch (e) {
      if (e instanceof Error && e.name === 'ResourceAlreadyExistsException') {
        diag.debug(`Log group ${this.logGroupName} already exists`);
      } else {
        diag.error(`Failed to create log group ${this.logGroupName}: ${e}`);
        throw e;
      }
    }
  }

  /**
   * Ensure the log stream exists, create if it doesn't.
   */
  private async ensureLogStreamExists(): Promise<void> {
    try {
      await context.with(suppressTracing(context.active()), async () => {
        await this.logsClient.createLogStream({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
        });
      });
      diag.info(`Created log stream: ${this.logStreamName}`);
    } catch (e) {
      if (e instanceof Error && e.name === 'ResourceAlreadyExistsException') {
        diag.debug(`Log stream ${this.logStreamName} already exists`);
      } else {
        diag.error(`Failed to create log stream ${this.logStreamName}: ${e}`);
        throw e;
      }
    }
  }

  /**
   * Validate the log event according to CloudWatch Logs constraints.
   */
  private validateLogEvent(logEvent: Required<LogEvent>): boolean {
    if (!logEvent.message || !logEvent.message.trim()) {
      diag.error('Empty log event message');
      return false;
    }

    // Check message size
    const messageSize = logEvent.message.length + CloudWatchLogsClient.CW_PER_EVENT_HEADER_BYTES;
    if (messageSize > CloudWatchLogsClient.CW_MAX_EVENT_PAYLOAD_BYTES) {
      diag.warn(
        `Log event size ${messageSize} exceeds maximum allowed size ${CloudWatchLogsClient.CW_MAX_EVENT_PAYLOAD_BYTES}. Truncating.`
      );
      const maxMessageSize =
        CloudWatchLogsClient.CW_MAX_EVENT_PAYLOAD_BYTES -
        CloudWatchLogsClient.CW_PER_EVENT_HEADER_BYTES -
        CloudWatchLogsClient.CW_TRUNCATED_SUFFIX.length;
      logEvent.message = logEvent.message.substring(0, maxMessageSize) + CloudWatchLogsClient.CW_TRUNCATED_SUFFIX;
    }

    // Check timestamp constraints
    const currentTime = Date.now();
    const timeDiff = currentTime - logEvent.timestamp;

    if (
      timeDiff > CloudWatchLogsClient.CW_EVENT_TIMESTAMP_LIMIT_PAST ||
      timeDiff < -CloudWatchLogsClient.CW_EVENT_TIMESTAMP_LIMIT_FUTURE
    ) {
      diag.error(
        `Log event timestamp ${logEvent.timestamp} is either older than 14 days or more than 2 hours in the future. ` +
          `Current time: ${currentTime}`
      );
      return false;
    }

    return true;
  }

  /**
   * Create a new log event batch.
   */
  private createEventBatch(): LogEventBatch {
    return new LogEventBatch();
  }

  /**
   * Check if adding the next event would exceed CloudWatch Logs limits.
   */
  private eventBatchExceedsLimit(batch: LogEventBatch, nextEventSize: number): boolean {
    return (
      batch.size() >= CloudWatchLogsClient.CW_MAX_REQUEST_EVENT_COUNT ||
      batch.byteTotal + nextEventSize > CloudWatchLogsClient.CW_MAX_REQUEST_PAYLOAD_BYTES
    );
  }

  /**
   * Check if the event batch spans more than 24 hours.
   *
   * @param batch The event batch
   * @param targetTimestampMs The timestamp of the event to add
   * @returns {boolean} true if the batch is active and can accept the event
   */
  private isBatchActive(batch: LogEventBatch, targetTimestampMs: number): boolean {
    // New log event batch
    if (batch.minTimestampMs === 0 || batch.maxTimestampMs === 0) {
      return true;
    }

    // Check if adding the event would make the batch span more than 24 hours
    if (targetTimestampMs - batch.minTimestampMs > 24 * 3600 * 1000) {
      return false;
    }

    if (batch.maxTimestampMs - targetTimestampMs > 24 * 3600 * 1000) {
      return false;
    }

    // Flush the event batch when reached 60s interval
    const currentTime = Date.now();
    if (currentTime - batch.createdTimestampMs >= CloudWatchLogsClient.BATCH_FLUSH_INTERVAL) {
      return false;
    }

    return true;
  }

  /**
   * Sort log events in the batch by timestamp.
   */
  private sortLogEvents(batch: LogEventBatch): void {
    batch.logEvents.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Send a batch of log events to CloudWatch Logs.
   */
  private async sendLogBatch(batch: LogEventBatch): Promise<PutLogEventsCommandOutput | void> {
    if (batch.isEmpty()) {
      return;
    }

    this.sortLogEvents(batch);

    const putLogEventsInput: PutLogEventsCommandInput = {
      logGroupName: this.logGroupName,
      logStreamName: this.logStreamName,
      logEvents: batch.logEvents,
    };

    const startTime = Date.now();

    try {
      const response: PutLogEventsCommandOutput = await context.with(suppressTracing(context.active()), async () => {
        const res = await this.logsClient.putLogEvents(putLogEventsInput);
        const elapsedMs = Date.now() - startTime;
        diag.debug(
          `Successfully sent ${batch.size()} log events ` +
            `(${(batch.byteTotal / 1024).toFixed(2)} KB) in ${elapsedMs} ms`
        );

        return res;
      });

      return response;
    } catch (e) {
      // Handle resource not found errors by creating log group/stream
      if (e instanceof Error && e.name === 'ResourceNotFoundException') {
        diag.info('Log group or stream not found, creating resources and retrying');
        try {
          // Create log group first then log stream
          await this.ensureLogGroupExists();
          await this.ensureLogStreamExists();

          // Retry the PutLogEvents call
          const response: PutLogEventsCommandOutput = await context.with(
            suppressTracing(context.active()),
            async () => {
              const res = await this.logsClient.putLogEvents(putLogEventsInput);

              const elapsedMs = Date.now() - startTime;
              diag.debug(
                `Successfully sent ${batch.size()} log events ` +
                  `(${(batch.byteTotal / 1024).toFixed(2)} KB) in ${elapsedMs} ms after creating resources`
              );
              return res;
            }
          );
          return response;
        } catch (e: unknown) {
          diag.error(`Failed to create log resources or failed to send log events: ${e}`);
          throw e;
        }
      } else {
        diag.error(`Failed to send log events: ${e}`);
        throw e;
      }
    }
  }

  /**
   * Send a log event to CloudWatch Logs.
   *
   * This function implements the same logic as the Go version in the OTel Collector.
   * It batches log events according to CloudWatch Logs constraints and sends them
   * when the batch is full or spans more than 24 hours.
   */
  public async sendLogEvent(logEvent: Required<LogEvent>): Promise<void> {
    try {
      if (!this.validateLogEvent(logEvent)) {
        return;
      }

      // Calculate event size
      const eventSize = logEvent.message.length + CloudWatchLogsClient.CW_PER_EVENT_HEADER_BYTES;

      // Initialize event batch if needed
      if (!this.eventBatch) {
        this.eventBatch = this.createEventBatch();
      }

      // Check if we need to send the current batch and create a new one
      let currentBatch = this.eventBatch;
      if (
        this.eventBatchExceedsLimit(currentBatch, eventSize) ||
        !this.isBatchActive(currentBatch, logEvent.timestamp)
      ) {
        // Send the current batch
        await this.sendLogBatch(currentBatch);
        // Create a new batch
        this.eventBatch = this.createEventBatch();
        currentBatch = this.eventBatch;
      }

      // Add the log event to the batch
      currentBatch.addEvent(logEvent, eventSize);
    } catch (e) {
      diag.error(`Failed to process log event: ${e}`);
      throw e;
    }
  }

  /**
   * Force flush any pending log events.
   */
  public async flushPendingEvents(): Promise<void> {
    if (this.eventBatch && !this.eventBatch.isEmpty()) {
      const currentBatch = this.eventBatch;
      this.eventBatch = this.createEventBatch();
      await this.sendLogBatch(currentBatch);
    }
    diag.debug('CloudWatchLogsClient flushed the buffered log events');
  }
}
