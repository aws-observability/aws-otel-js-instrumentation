// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import * as sinon from 'sinon';
import { CloudWatchLogsClient } from '../../../../src/exporter/aws/metrics/cloudwatch-logs-client';
import type { LogEvent } from '@aws-sdk/client-cloudwatch-logs';

describe('TestCloudWatchLogsClient', () => {
  let logClient: CloudWatchLogsClient;
  const { CloudWatchLogs } = require('@aws-sdk/client-cloudwatch-logs');

  beforeEach(() => {
    /* Set up test fixtures. */
    // Stub CloudWatchLogs to avoid AWS calls
    sinon.stub(CloudWatchLogs.prototype, 'describeLogGroups').callsFake(input => {
      return { logGroups: [] };
    });
    sinon.stub(CloudWatchLogs.prototype, 'createLogGroup').callsFake(input => {
      return {};
    });
    sinon.stub(CloudWatchLogs.prototype, 'createLogStream').callsFake(input => {
      return {};
    });

    logClient = new CloudWatchLogsClient('test-log-group');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('TestInitialization', () => {
    /* Test log client initialization. */
    expect(logClient['logGroupName']).toEqual('test-log-group');
    expect(logClient['logStreamName']).not.toBeUndefined();
    expect(logClient['logStreamName'].startsWith('otel-js-')).toBeTruthy();
  });

  it('TestInitializationWithCustomParams', async () => {
    /* Test log client initialization with custom parameters. */

    const newLogClient = new CloudWatchLogsClient('custom-log-group', 'custom-stream', {});

    expect(newLogClient['logGroupName']).toEqual('custom-log-group');
    expect(newLogClient['logStreamName']).toEqual('custom-stream');
    expect(newLogClient['logsClient']).toBeInstanceOf(CloudWatchLogs);
  });

  it('TestGenerateLogStreamName', () => {
    /* Test log stream name generation. */
    const name1 = logClient['generateLogStreamName']();
    const name2 = logClient['generateLogStreamName']();

    // Should generate unique names
    expect(name1).not.toEqual(name2);
    expect(name1.startsWith('otel-js-')).toBeTruthy();
    expect(name2.startsWith('otel-js-')).toBeTruthy();
  });

  it('TestCreateLogGroupIfNeeded', async () => {
    /* Test log group creation when needed. */
    // This method should not raise an exception
    await logClient['ensureLogGroupExists']();
  });

  it('TestCreateLogGroupIfNeededAlreadyExists', async () => {
    /* Test log group creation when it already exists. */
    // Mock the createLogGroup to raise ResourceAlreadyExistsException
    (logClient['logsClient'].createLogGroup as any).callsFake(async () => {
      const err = new Error('SpecifiedError');
      err.name = 'ResourceAlreadyExistsException';
      throw err;
    });

    // This should not raise an exception
    await logClient['ensureLogGroupExists']();
  });

  it('TestCreateLogGroupIfNeededFailure', async () => {
    /* Test log group creation failure. */
    // Mock the createLogGroup to raise AccessDenied error
    (logClient['logsClient'].createLogGroup as any).callsFake(async () => {
      const err = new Error('SpecifiedError');
      err.name = 'AccessDenied';
      throw err;
    });

    await expect(logClient['ensureLogGroupExists']()).rejects.toThrow('SpecifiedError');
  });

  it('TestCreateEventBatch', () => {
    /* Test event batch creation. */
    const batch = logClient['createEventBatch']();

    expect(batch.logEvents).toEqual([]);
    expect(batch.byteTotal).toEqual(0);
    expect(batch.minTimestampMs).toEqual(0);
    expect(batch.maxTimestampMs).toEqual(0);
    expect(typeof batch.createdTimestampMs).toEqual('number');
  });

  it('TestValidateLogEventValid', () => {
    /* Test log event validation with valid event. */
    const logEvent = {
      message: 'test message',
      timestamp: Date.now(),
    };

    const result = logClient['validateLogEvent'](logEvent);
    expect(result).toBeTruthy();
  });

  it('TestValidateLogEventEmptyMessage', () => {
    /* Test log event validation with empty message. */
    const logEvent = {
      message: '',
      timestamp: Date.now(),
    };

    const result = logClient['validateLogEvent'](logEvent);
    expect(result).toBeFalsy();
  });

  it('TestValidateLogEventEmptyWhitespaceMessage', () => {
    /* Test log event validation with empty whitespace message. */
    const logEvent = {
      message: '   ',
      timestamp: Date.now(),
    };

    const result = logClient['validateLogEvent'](logEvent);
    expect(result).toBeFalsy();
  });

  it('TestValidateLogEventMissingMessage', () => {
    /* Test log event validation with missing message. */
    const logEvent: LogEvent = {
      timestamp: Date.now(),
    };

    const result = logClient['validateLogEvent'](logEvent as any);
    expect(result).toBeFalsy();
  });

  it('TestValidateLogEventOversizedMessage', () => {
    /* Test log event validation with oversized message. */
    // Create a ma message larger than the maximum allowed size
    const largeMessage = 'x'.repeat(CloudWatchLogsClient.CW_MAX_EVENT_PAYLOAD_BYTES + 100);
    const logEvent = {
      message: largeMessage,
      timestamp: Date.now(),
    };

    const result = logClient['validateLogEvent'](logEvent);
    expect(result).toBeTruthy(); // Should still be valid after truncation
    // Check that message was truncated
    expect(logEvent.message.length).toBeLessThan(largeMessage.length);
    expect(logEvent.message.endsWith(CloudWatchLogsClient.CW_TRUNCATED_SUFFIX)).toBeTruthy();
  });

  it('TestValidateLogEventOldTimestamp', () => {
    /* Test log event validation with veryery old timestamp. */
    // Timestamp from 15 days ago
    const oldTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const logEvent = {
      message: 'test message',
      timestamp: oldTimestamp,
    };

    const result = logClient['validateLogEvent'](logEvent);
    expect(result).toBeFalsy();
  });

  it('TestValidateLogEventFutureTimestamp', () => {
    /* Test log event validation with future timestamp. */
    // Timestamp 3 hours in the future
    const futureTimestamp = Date.now() + 3 * 60 * 60 * 1000;
    const logEvent = {
      message: 'test message',
      timestamp: futureTimestamp,
    };

    const result = logClient['validateLogEvent'](logEvent);
    expect(result).toBeFalsy();
  });

  it('TestEventBatchExceedsLimitByCount', () => {
    /* Test batch limit checking by event count. */
    const batch = logClient['createEventBatch']();
    // Simulate batch with maximum events
    batch.logEvents = Array(CloudWatchLogsClient.CW_MAX_REQUEST_EVENT_COUNT).fill({ message: 'test' });

    const result = logClient['eventBatchExceedsLimit'](batch, 100);
    expect(result).toBeTruthy();
  });

  it('TestEventBatchExceedsLimitBySize', () => {
    /* Test batch limit checking by byte size. */
    const batch = logClient['createEventBatch']();
    batch.byteTotal = CloudWatchLogsClient.CW_MAX_REQUEST_PAYLOAD_BYTES - 50;

    const result = logClient['eventBatchExceedsLimit'](batch, 100);
    expect(result).toBeTruthy();
  });

  it('TestEventBatchWithinLimits', () => {
    /* Test batch limit checking within limits. */
    const batch = logClient['createEventBatch']();
    batch.logEvents = Array(10).fill({ message: 'test' });
    batch.byteTotal = 1000;

    const result = logClient['eventBatchExceedsLimit'](batch, 100);
    expect(result).toBeFalsy();
  });

  it('TestIsBatchActiveNewBatch', () => {
    /* Test batch activity check for new batch. */
    const batch = logClient['createEventBatch']();
    const currentTime = Date.now();

    const result = logClient['isBatchActive'](batch, currentTime);
    expect(result).toBeTruthy();
  });

  it('TestIsBatchActive24HourSpan', () => {
    /* Test batch activity check for 24+ hour span. */
    const batch = logClient['createEventBatch']();
    const currentTime = Date.now();
    batch.minTimestampMs = currentTime;
    batch.maxTimestampMs = currentTime;

    // Test with timestamp 25 hours in the future
    const futureTimestamp = currentTime + 25 * 60 * 60 * 1000;

    const result = logClient['isBatchActive'](batch, futureTimestamp);
    expect(result).toBeFalsy();
  });

  it('TestIsBatchActive60sInterval', () => {
    /* Test batch activity check when flush interval is reached. */
    const batch = logClient['createEventBatch']();
    const currentTime = Date.now();
    batch.minTimestampMs = currentTime;
    batch.maxTimestampMs = currentTime;
    batch.createdTimestampMs = currentTime - (CloudWatchLogsClient.BATCH_FLUSH_INTERVAL + 1000);

    const result = logClient['isBatchActive'](batch, currentTime);
    expect(result).toBeFalsy();
  });

  it('TestAppendToBatch', () => {
    /* Test adding log event to batch. */
    const batch = logClient['createEventBatch']();
    const logEvent = {
      message: 'test message',
      timestamp: Date.now(),
    };
    const eventSize = 100;

    batch.addEvent(logEvent, eventSize);

    expect(batch.logEvents.length).toEqual(1);
    expect(batch.byteTotal).toEqual(eventSize);
    expect(batch.minTimestampMs).toEqual(logEvent.timestamp);
    expect(batch.maxTimestampMs).toEqual(logEvent.timestamp);
  });

  it('TestSortLogEvents', () => {
    /* Test sorting log events by timestamp. */
    const batch = logClient['createEventBatch']();
    const currentTime = Date.now();

    // Add events with timestamps in reverse order
    const events = [
      { message: 'third', timestamp: currentTime + 2000 },
      { message: 'first', timestamp: currentTime },
      { message: 'second', timestamp: currentTime + 1000 },
    ];

    batch.logEvents = [...events];
    logClient['sortLogEvents'](batch);

    // Check that events are now sorted by timestamp
    expect(batch.logEvents[0].message).toEqual('first');
    expect(batch.logEvents[1].message).toEqual('second');
    expect(batch.logEvents[2].message).toEqual('third');
  });

  it('TestFlushPendingEvents', async () => {
    /* Test flush pending events functionality with pending events. */
    // Create a batch with events
    logClient['eventBatch'] = logClient['createEventBatch']();
    logClient['eventBatch'].addEvent({ message: 'test', timestamp: Date.now() }, 10);

    const sendLogBatchStub = sinon.stub(logClient, <any>'sendLogBatch').resolves();

    await logClient.flushPendingEvents();

    expect(sendLogBatchStub.calledOnce).toBeTruthy();
  });

  it('TestFlushPendingEventsNoPendingEvents', async () => {
    /* Test flush pending events functionality with no pending events. */
    // No batch exists
    logClient['eventBatch'] = undefined;

    await logClient.flushPendingEvents();
  });

  it('TestSendLogEvent', async () => {
    /* Test that sendLogEvent method exists and can be called. */
    // Just test that the method exists and doesn't crash with basic input
    const logEvent = { message: 'test message', timestamp: 1234567890 };

    // Mock the AWS client methods to avoid actual AWS calls
    sinon.stub(logClient['logsClient'], 'putLogEvents').resolves({ nextSequenceToken: '12345' });

    // Should not throw an exception
    await expect(logClient.sendLogEvent(logEvent)).resolves.not.toThrow();
  });

  it('TestSendLogBatchWithResourceNotFound', async () => {
    /* Test lazy creation when putLogEvents fails with ResourceNotFoundException. */
    const batch = logClient['createEventBatch']();
    batch.addEvent({ message: 'test message', timestamp: Date.now() }, 10);

    // Mock putLogEvents to fail first, then succeed
    const mockPutLogEvents = sinon.stub(logClient['logsClient'], 'putLogEvents');

    const rejectErr = new Error('test error');
    rejectErr.name = 'ResourceNotFoundException';
    mockPutLogEvents.onFirstCall().rejects(rejectErr);
    mockPutLogEvents.onSecondCall().resolves({ nextSequenceToken: '12345' });

    // Mock the create methods
    const mockCreateLogGroup = sinon.stub(logClient, <any>'ensureLogGroupExists').resolves();
    const mockCreateLogStream = sinon.stub(logClient, <any>'ensureLogStreamExists').resolves();

    // Should not raise an exception and should create resources
    await logClient['sendLogBatch'](batch);

    expect(mockCreateLogGroup.calledOnce).toBeTruthy();
    expect(mockCreateLogStream.calledOnce).toBeTruthy();
    expect(mockPutLogEvents.calledTwice).toBeTruthy();
  });

  it('TestSendLogBatchWithOtherError', async () => {
    /* Test that non-ResourceNotFoundException errors are re-raised. */
    const batch = logClient['createEventBatch']();
    batch.addEvent({ message: 'test message', timestamp: Date.now() }, 10);

    const rejectErr = new Error('test error');
    rejectErr.name = 'AccessDenied';

    // Mock putLogEvents to fail with different error
    sinon.stub(logClient['logsClient'], 'putLogEvents').rejects(rejectErr);

    await expect(logClient['sendLogBatch'](batch)).rejects.toThrow('test error');
  });

  it('TestCreateLogStreamIfNeededSuccess', async () => {
    /* Test log stream creation when needed. */
    // This method should not raise an exception
    await logClient['ensureLogStreamExists']();
  });

  it('TestCreateLogStreamIfNeededAlreadyExists', async () => {
    /* Test log stream creation when it already exists. */
    // Mock the createLogStream to raise ResourceAlreadyExistsException
    (logClient['logsClient'].createLogStream as any).callsFake(async () => {
      const err = new Error('SpecifiedError');
      err.name = 'ResourceAlreadyExistsException';
      throw err;
    });

    // This should not raise an exception
    await logClient['ensureLogStreamExists']();
  });

  it('TestCreateLogStreamIfNeededFailure', async () => {
    /* Test log stream creation failure. */
    // Mock the createLogStream to raise AccessDenied error
    (logClient['logsClient'].createLogStream as any).callsFake(async () => {
      const err = new Error('SpecifiedError');
      err.name = 'AccessDenied';
      throw err;
    });

    await expect(logClient['ensureLogStreamExists']()).rejects.toThrow('SpecifiedError');
  });

  it('TestSendLogBatchSuccess', async () => {
    /* Test successful log batch sending. */
    const batch = logClient['createEventBatch']();
    batch.addEvent({ message: 'test message', timestamp: Date.now() }, 10);

    // Mock successful putLogEvents call
    sinon.stub(logClient['logsClient'], 'putLogEvents').resolves({ nextSequenceToken: '12345' });

    // Should not raise an exception
    const result = await logClient['sendLogBatch'](batch);
    expect(result!.nextSequenceToken).toEqual('12345');
  });

  it('TestSendLogBatchEmptyBatch', async () => {
    /* Test sending empty batch does nothing. */
    const batch = logClient['createEventBatch']();

    const putLogEventsSpy = sinon.spy(logClient['logsClient'].putLogEvents);

    // Empty batch should return early without calling AWS
    const result = await logClient['sendLogBatch'](batch);
    expect(result).toBeUndefined();

    // Verify putLogEvents was not called
    sinon.assert.notCalled(putLogEventsSpy);
  });

  it('TestSendLogEventWithInvalidEvent', async () => {
    /* Test sendLogEvent with an invalid event that fails validation. */
    // Create an event that will fail validation (empty message)
    const logEvent = { message: '', timestamp: Date.now() };
    const putLogEventsSpy = sinon.spy(logClient['logsClient'].putLogEvents);

    // Should not raise an exception, but should not call putLogEvents
    await logClient.sendLogEvent(logEvent);

    // Verify putLogEvents was not called due to validation failure
    sinon.assert.notCalled(putLogEventsSpy);
  });

  it('TestSendLogEventBatchingLogic', async () => {
    /* Test that sendLogEvent properly batches events. */
    const logEvent = { message: 'test message', timestamp: Date.now() };

    // Mock putLogEvents to not be called initially (batching)
    const putLogEventsStub = sinon
      .stub(logClient['logsClient'], 'putLogEvents')
      .resolves({ nextSequenceToken: '12345' });

    // Send one event (should be batched, not sent immediately)
    await logClient.sendLogEvent(logEvent);

    // Verify event was added to batch
    expect(logClient['eventBatch']).not.toBeUndefined();
    expect(logClient['eventBatch']!.size()).toEqual(1);

    // putLogEvents should not be called yet (event is batched)
    sinon.assert.notCalled(putLogEventsStub);
  });

  it('TestSendLogEventForceBatchSend', async () => {
    /* Test that sendLogEvent sends batch when limits are exceeded. */
    // Mock putLogEvents
    const putLogEventsStub = sinon
      .stub(logClient['logsClient'], 'putLogEvents')
      .resolves({ nextSequenceToken: '12345' });

    // Create events to reach the maximum event count limit
    const currentTime = Date.now();

    // Send events up to the limit (should all be batched)
    for (let i = 0; i < CloudWatchLogsClient.CW_MAX_REQUEST_EVENT_COUNT; i++) {
      const logEvent = { message: `test message ${i}`, timestamp: currentTime };
      await logClient.sendLogEvent(logEvent);
    }

    // At this point, no batch should have been sent yet
    sinon.assert.notCalled(putLogEventsStub);

    // Send one more event (should trigger batch send due to count limit)
    const finalEvent = { message: 'final message', timestamp: currentTime };
    await logClient.sendLogEvent(finalEvent);

    // putLogEvents should have been called once
    sinon.assert.calledOnce(putLogEventsStub);
  });

  it('TestLogEventBatchClear', () => {
    /* Test clearing a log event batch. */
    const batch = logClient['createEventBatch']();
    batch.addEvent({ message: 'test', timestamp: Date.now() }, 100);

    // Verify batch has content
    expect(batch.isEmpty()).toBeFalsy();
    expect(batch.size()).toEqual(1);

    // Clear and verify
    batch.clear();
    expect(batch.isEmpty()).toBeTruthy();
    expect(batch.size()).toEqual(0);
    expect(batch.byteTotal).toEqual(0);
  });

  it('TestLogEventBatchTimestampTracking', () => {
    /* Test timestamp tracking in LogEventBatch. */
    const batch = logClient['createEventBatch']();
    const currentTime = Date.now();

    // Add first event
    batch.addEvent({ message: 'first', timestamp: currentTime }, 10);
    expect(batch.minTimestampMs).toEqual(currentTime);
    expect(batch.maxTimestampMs).toEqual(currentTime);

    // Add earlier event
    const earlierTime = currentTime - 1000;
    batch.addEvent({ message: 'earlier', timestamp: earlierTime }, 10);
    expect(batch.minTimestampMs).toEqual(earlierTime);
    expect(batch.maxTimestampMs).toEqual(currentTime);

    // Add later event
    const laterTime = currentTime + 1000;
    batch.addEvent({ message: 'later', timestamp: laterTime }, 10);
    expect(batch.minTimestampMs).toEqual(earlierTime);
    expect(batch.maxTimestampMs).toEqual(laterTime);
  });

  it('TestGenerateLogStreamNameFormatAndUniqueness', () => {
    /* Test log stream name generation format and uniqueness. */
    const name1 = logClient['generateLogStreamName']();
    const name2 = logClient['generateLogStreamName']();

    expect(name1.startsWith('otel-js-')).toBeTruthy();
    expect(name1.length).toEqual('otel-js-'.length + 8);
    expect(name1).not.toEqual(name2);
  });

  it('TestInitializationWithCustomLogStreamName', () => {
    /* Test initialization with custom log stream name. */
    const customStream = 'my-custom-stream';
    const client = new CloudWatchLogsClient('test-group', customStream);
    expect(client['logStreamName']).toEqual(customStream);
  });

  it('TestSendLogBatchEmptyBatchNoAwsCall', async () => {
    /* Test sending an empty batch returns undefined and doesn't call AWS. */
    const putLogEventsSpy = sinon.spy(logClient['logsClient'].putLogEvents);
    const batch = logClient['createEventBatch']();
    const result = await logClient['sendLogBatch'](batch);
    expect(result).toBeUndefined();

    // Verify putLogEvents is not called for empty batch
    sinon.assert.notCalled(putLogEventsSpy);
  });

  it('TestValidateLogEventInvalidTimestampPast', () => {
    /* Test validation of log event with timestamp too far in the past. */
    // Create timestamp older than 14 days
    const oldTime = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const logEvent = { message: 'test message', timestamp: oldTime };

    const result = logClient['validateLogEvent'](logEvent);
    expect(result).toBeFalsy();
  });

  it('TestValidateLogEventInvalidTimestampFuture', () => {
    /* Test validation of log event with timestamp too far in the future. */
    // Create timestamp more than 2 hours in the future
    const futureTime = Date.now() + 3 * 60 * 60 * 1000;
    const logEvent = { message: 'test message', timestamp: futureTime };

    const result = logClient['validateLogEvent'](logEvent);
    expect(result).toBeFalsy();
  });

  it('TestSendLogEventValidationFailure', async () => {
    /* Test sendLogEvent when validation fails. */
    // Create invalid event (empty message)
    const invalidEvent = { message: '', timestamp: Date.now() };

    // Mock putLogEvents to track calls
    const mockPutLogEvents = sinon
      .stub(logClient['logsClient'], 'putLogEvents')
      .resolves({ nextSequenceToken: '12345' });

    // Send invalid event
    await logClient.sendLogEvent(invalidEvent);

    // Should not call putLogEvents or create batch
    sinon.assert.notCalled(mockPutLogEvents);
    expect(logClient['eventBatch']).toBeUndefined();
  });

  it('TestSendLogEventExceptionHandling', async () => {
    /* Test exception handling in sendLogEvent. */
    // Mock validateLogEvent to raise an exception
    sinon.stub(logClient, <any>'validateLogEvent').throws(new Error('Test error'));

    const logEvent = { message: 'test', timestamp: Date.now() };

    await expect(logClient.sendLogEvent(logEvent)).rejects.toThrow('Test error');
  });

  it('TestFlushPendingEventsNoBatch', async () => {
    /* Test flush pending events when no batch exists. */
    // Ensure no batch exists
    logClient['eventBatch'] = undefined;

    const mockSendLogBatch = sinon.stub(logClient, <any>'sendLogBatch').resolves();

    await logClient.flushPendingEvents();

    // Should not call sendLogBatch
    sinon.assert.notCalled(mockSendLogBatch);
  });

  it('TestIsBatchActiveEdgeCases', () => {
    /* Test edge cases for batch activity checking. */
    const batch = logClient['createEventBatch']();
    const currentTime = Date.now();

    // Test exactly at 24 hour boundary (should still be active)
    batch.addEvent({ message: 'test', timestamp: currentTime }, 10);
    const exactly24hFuture = currentTime + 24 * 60 * 60 * 1000;
    let result = logClient['isBatchActive'](batch, exactly24hFuture);
    expect(result).toBeTruthy();

    // Test just over 24 hour boundary (should be inactive)
    const over24hFuture = currentTime + (24 * 60 * 60 * 1000 + 1);
    result = logClient['isBatchActive'](batch, over24hFuture);
    expect(result).toBeFalsy();

    // Test exactly at flush interval boundary
    // Create a new batch for this test
    const batch2 = logClient['createEventBatch']();
    batch2.addEvent({ message: 'test', timestamp: currentTime }, 10);
    batch2.createdTimestampMs = currentTime - CloudWatchLogsClient.BATCH_FLUSH_INTERVAL;
    result = logClient['isBatchActive'](batch2, currentTime);
    expect(result).toBeFalsy();
  });
});
