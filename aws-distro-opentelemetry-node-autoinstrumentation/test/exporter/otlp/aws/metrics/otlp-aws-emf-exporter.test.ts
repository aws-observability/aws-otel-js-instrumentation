// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { applyInstrumentationPatches } from '../../../../../src/patches/instrumentation-patch';

// Central location to register instrumentation for testing for all tests in this project
const instrumentations: AwsInstrumentation[] = [new AwsInstrumentation()];
applyInstrumentationPatches(instrumentations);
process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'http';
registerInstrumentationTesting(instrumentations[0]);

import { ValueType } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import expect from 'expect';
import * as sinon from 'sinon';
import {
  PutLogEventsCommandInput,
  CloudWatchLogs,
  PutLogEventsCommandOutput,
  CreateLogGroupCommandInput,
  CreateLogGroupCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  AWSCloudWatchEMFExporter,
  CW_MAX_EVENT_PAYLOAD_BYTES,
  CW_MAX_REQUEST_EVENT_COUNT,
  CW_MAX_REQUEST_PAYLOAD_BYTES,
  CW_TRUNCATED_SUFFIX,
  MetricRecord,
} from '../../../../../src/exporter/otlp/aws/metrics/otlp-aws-emf-exporter';
import {
  Aggregation,
  AggregationTemporality,
  DataPoint,
  DataPointType,
  GaugeMetricData,
  InstrumentType,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { ExportResultCode } from '@opentelemetry/core';
import { HttpHandlerOptions } from '@smithy/protocol-http';

describe('TestBatchProcessing', () => {
  let exporter: AWSCloudWatchEMFExporter;

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

    exporter = new AWSCloudWatchEMFExporter(
      'TestNamespace',
      'test-log-group',
      undefined,
      AggregationTemporality.DELTA,
      {}
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('TestCreateEventBatch', () => {
    /* Test event batch creation. */
    const batch = exporter['createEventBatch']();

    expect(batch['logEvents']).toEqual([]);
    expect(batch['byteTotal']).toEqual(0);
    expect(batch['minTimestampMs']).toEqual(0);
    expect(batch['maxTimestampMs']).toEqual(0);
    expect(typeof batch['createdTimestampMs']).toEqual('number');
  });

  it('TestValidateLogEventValid', () => {
    /* Test log event validation with valid event. */
    const logEvent = {
      message: 'test message',
      timestamp: Date.now(),
    };

    const result = exporter['validateLogEvent'](logEvent);
    expect(result).toBeTruthy();
  });

  it('TestValidateLogEventEmptyMessage', () => {
    /* Test log event validation with empty message. */
    const logEvent = {
      message: '',
      timestamp: Date.now(),
    };

    const result = exporter['validateLogEvent'](logEvent);
    expect(result).toBeFalsy();
  });

  it('TestValidateLogEventOversizedMessage', () => {
    /* Test log event validation with oversized message. */
    // Create a message larger than the maximum allowed size
    const largeMessage = 'x'.repeat(CW_MAX_EVENT_PAYLOAD_BYTES + 100);
    const logEvent = {
      message: largeMessage,
      timestamp: Date.now(),
    };

    const result = exporter['validateLogEvent'](logEvent);
    expect(result).toBeTruthy(); // Should still be valid after truncation
    // Check that message was truncated
    expect(logEvent['message'].length).toBeLessThan(largeMessage.length);
    expect(logEvent['message'].endsWith(CW_TRUNCATED_SUFFIX)).toBeTruthy();
  });

  it('TestValidateLogEventOldTimestamp', () => {
    /* Test log event validation with very old timestamp. */
    // Timestamp from 15 days ago
    const oldTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const logEvent = {
      message: 'test message',
      timestamp: oldTimestamp,
    };

    const result = exporter['validateLogEvent'](logEvent);
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

    const result = exporter['validateLogEvent'](logEvent);
    expect(result).toBeFalsy();
  });

  it('TestEventBatchExceedsLimitByCount', () => {
    /* Test batch limit checking by event count. */
    const batch = exporter['createEventBatch']();
    // Simulate batch with maximum events
    batch['logEvents'] = Array(CW_MAX_REQUEST_EVENT_COUNT).fill({ message: 'test' });

    const result = exporter['eventBatchExceedsLimit'](batch, 100);
    expect(result).toBeTruthy();
  });

  it('TestEventBatchExceedsLimitBySize', () => {
    /* Test batch limit checking by byte size. */
    const batch = exporter['createEventBatch']();
    batch['byteTotal'] = CW_MAX_REQUEST_PAYLOAD_BYTES - 50;

    const result = exporter['eventBatchExceedsLimit'](batch, 100);
    expect(result).toBeTruthy();
  });

  it('TestEventBatchWithinLimits', () => {
    /* Test batch limit checking within limits. */
    const batch = exporter['createEventBatch']();
    batch['logEvents'] = Array(10).fill({ message: 'test' });
    batch['byteTotal'] = 1000;

    const result = exporter['eventBatchExceedsLimit'](batch, 100);
    expect(result).toBeFalsy();
  });

  it('TestIsBatchActiveNewBatch', () => {
    /* Test batch activity check for new batch. */
    const batch = exporter['createEventBatch']();
    const currentTime = Date.now();

    const result = exporter['isBatchActive'](batch, currentTime);
    expect(result).toBeTruthy();
  });

  it('TestIsBatchActive24HourSpan', () => {
    /* Test batch activity check for 24+ hour span. */
    const batch = exporter['createEventBatch']();
    const currentTime = Date.now();
    batch['minTimestampMs'] = currentTime;
    batch['maxTimestampMs'] = currentTime;

    // Test with timestamp 25 hours in the future
    const futureTimestamp = currentTime + 25 * 60 * 60 * 1000;

    const result = exporter['isBatchActive'](batch, futureTimestamp);
    expect(result).toBeFalsy();
  });

  it('TestIsBatchActive60sInterval', () => {
    /* Test batch activity check for 24+ hour span. */
    const batch = exporter['createEventBatch']();
    const currentTime = Date.now();
    batch['minTimestampMs'] = currentTime;
    batch['maxTimestampMs'] = currentTime;

    let result = exporter['isBatchActive'](batch, 0);
    expect(result).toBeFalsy();

    batch.maxTimestampMs = batch.minTimestampMs + 24 * 3600 * 1001;
    result = exporter['isBatchActive'](batch, 0);
    expect(result).toBeFalsy();

    batch.maxTimestampMs = 1;
    batch.createdTimestampMs = 0;
    result = exporter['isBatchActive'](batch, 0);
    expect(result).toBeFalsy();

    batch.createdTimestampMs = Date.now();
    result = exporter['isBatchActive'](batch, 0);
    expect(result).toBeTruthy();
  });

  it('TestAppendToBatch', () => {
    /* Test appending log event to batch. */
    const batch = exporter['createEventBatch']();
    const logEvent = {
      message: 'test message',
      timestamp: Date.now(),
    };
    const eventSize = 100;

    exporter['appendToBatch'](batch, logEvent, eventSize);

    expect(batch['logEvents'].length).toEqual(1);
    expect(batch['byteTotal']).toEqual(eventSize);
    expect(batch['minTimestampMs']).toEqual(logEvent['timestamp']);
    expect(batch['maxTimestampMs']).toEqual(logEvent['timestamp']);
  });

  it('TestSortLogEvents', () => {
    /* Test sorting log events by timestamp. */
    const batch = exporter['createEventBatch']();
    const currentTime = Date.now();

    // Add events with timestamps in reverse order
    const events = [
      { message: 'third', timestamp: currentTime + 2000 },
      { message: 'first', timestamp: currentTime },
      { message: 'second', timestamp: currentTime + 1000 },
    ];

    batch['logEvents'] = [...events];
    exporter['sortLogEvents'](batch);

    // Check that events are now sorted by timestamp
    expect(batch['logEvents'][0]['message']).toEqual('first');
    expect(batch['logEvents'][1]['message']).toEqual('second');
    expect(batch['logEvents'][2]['message']).toEqual('third');
  });
});

describe('TestSendLogBatch', () => {
  let exporter: AWSCloudWatchEMFExporter;
  let createLogGroupStub: sinon.SinonStub<
    [
      args: CreateLogGroupCommandInput,
      options: HttpHandlerOptions,
      cb: (err: any, data?: CreateLogGroupCommandOutput) => void
    ],
    void
  >;
  let putLogEventsStub: sinon.SinonStub<
    [
      args: PutLogEventsCommandInput,
      options: HttpHandlerOptions,
      cb: (err: any, data?: PutLogEventsCommandOutput) => void
    ],
    void
  >;

  beforeEach(async () => {
    // Stub CloudWatchLogs to avoid AWS calls
    sinon.stub(CloudWatchLogs.prototype, 'describeLogGroups').callsFake(input => {
      return { logGroups: [] };
    });
    createLogGroupStub = sinon.stub(CloudWatchLogs.prototype, 'createLogGroup').callsFake(input => {
      return {};
    });
    sinon.stub(CloudWatchLogs.prototype, 'createLogStream').callsFake(input => {
      return {};
    });
    putLogEventsStub = sinon.stub(CloudWatchLogs.prototype, 'putLogEvents').callsFake(input => {
      return { nextSequenceToken: '12345' };
    });

    exporter = new AWSCloudWatchEMFExporter(
      'TestNamespace',
      'test-log-group',
      undefined,
      AggregationTemporality.DELTA,
      {}
    );
    await exporter['logStreamExistsPromise'];
  });

  afterEach(() => {
    sinon.restore();
  });

  it('TestSendLogBatchEmpty', async () => {
    /* Test sending empty log batch. */

    const batch = exporter['createEventBatch']();
    // Should not make any AWS calls for empty batch
    await exporter['sendLogBatch'](batch);

    sinon.assert.notCalled(putLogEventsStub);
  });

  it('TestSendLogBatchWithEvents', async () => {
    /* Test sending log batch with events. */
    const batch = exporter['createEventBatch']();
    const currentTime = Date.now();

    // Add some log events
    const events = [
      { message: 'first message', timestamp: currentTime },
      { message: 'second message', timestamp: currentTime + 1000 },
    ];

    for (const event of events) {
      batch['logEvents'].push(event);
    }

    await exporter['sendLogBatch'](batch);

    sinon.assert.calledOnce(putLogEventsStub);

    const putLogEventsCallArg1 = putLogEventsStub.getCall(0).args[0];
    expect(putLogEventsCallArg1.logGroupName).toEqual('test-log-group');
    expect(putLogEventsCallArg1.logEvents?.length).toEqual(2);
  });

  it('TestSendLogBatchSortsEvents', async () => {
    /* Test that log batch sorting works correctly. */
    const batch = exporter['createEventBatch']();
    const currentTime = Date.now();

    // Add events in reverse timestamp order
    const events = [
      { message: 'second', timestamp: currentTime + 1000 },
      { message: 'first', timestamp: currentTime },
    ];

    for (const event of events) {
      batch['logEvents'].push(event);
    }

    await exporter['sendLogBatch'](batch);

    // Verify events were sorted by timestamp
    const putLogEventsCallArg1 = putLogEventsStub.getCall(0).args[0];
    const sortedEvents = putLogEventsCallArg1.logEvents;

    expect(sortedEvents?.length).toEqual(2);
    expect(sortedEvents ? sortedEvents[0].message : undefined).toEqual('first');
    expect(sortedEvents ? sortedEvents[1].message : undefined).toEqual('second');
  });

  // First exception is handled, second exception is thrown
  it('TestSendLogBatchHandlesExceptions', async () => {
    // Need to update these stubs for this test to throw errors
    createLogGroupStub.restore();
    putLogEventsStub.restore();
    /* Test that sendLogBatch handles exceptions properly. */
    const batch = exporter['createEventBatch']();
    batch['logEvents'].push({ message: 'test', timestamp: Date.now() });

    createLogGroupStub = sinon.stub(CloudWatchLogs.prototype, 'createLogGroup').callsFake(input => {
      throw Error('AWS error');
    });
    putLogEventsStub = sinon.stub(CloudWatchLogs.prototype, 'putLogEvents').callsFake(input => {
      throw Error('AWS test error 123');
    });

    await expect(exporter['sendLogBatch'](batch)).rejects.toThrow('AWS test error 123');
  });
});

describe('TestSendLogEvent', () => {
  /* Test individual log event sending functionality. */
  let exporter: AWSCloudWatchEMFExporter;

  beforeEach(() => {
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
    sinon.stub(CloudWatchLogs.prototype, 'putLogEvents').callsFake(input => {
      return { nextSequenceToken: '12345' };
    });
    exporter = new AWSCloudWatchEMFExporter(
      'TestNamespace',
      'test-log-group',
      undefined,
      AggregationTemporality.DELTA,
      {}
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('TestSendLogEventCreatesBatch', async () => {
    /* Test that sending first log event creates a batch. */
    const logEvent = {
      message: 'test message',
      timestamp: Date.now(),
    };

    // Initially no batch should exist
    expect(exporter['eventBatch']).toBeUndefined();

    await exporter['sendLogEvent'](logEvent);

    // Batch should now be created
    expect(exporter['eventBatch']).not.toBeUndefined();
    expect(exporter['eventBatch'] ? exporter['eventBatch']['logEvents'].length : -1).toEqual(1);
  });

  it('TestSendLogEventInvalidEvent', async () => {
    /* Test sending invalid log event. */
    const logEvent = {
      message: '', // Empty message should be invalid
      timestamp: Date.now(),
    };

    await exporter['sendLogEvent'](logEvent);

    // Batch should not be created for invalid event
    expect(exporter['eventBatch']).toBeUndefined();
  });

  it('TestSendLogEventTriggersBatchSend', async () => {
    /* Test that exceeding batch limits triggers batch send. */

    const sendLogBatchStub = sinon.stub(exporter, <any>'sendLogBatch');

    // First, add an event to create a batch
    const logEvent = {
      message: 'test message',
      timestamp: Date.now(),
    };
    await exporter['sendLogEvent'](logEvent);

    // Now simulate batch being at limit
    exporter['eventBatch']!['logEvents'] = Array(CW_MAX_REQUEST_EVENT_COUNT).fill({ message: 'test' });

    // Send another event that should trigger batch send
    await exporter['sendLogEvent'](logEvent);

    // Verify batch was sent
    sinon.assert.calledOnce(sendLogBatchStub);
  });
});

describe('TestAWSCloudWatchEMFExporter', () => {
  /* Test AWSCloudWatchEMFExporter class. */
  let exporter: AWSCloudWatchEMFExporter;

  beforeEach(async () => {
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

    exporter = new AWSCloudWatchEMFExporter(
      'TestNamespace',
      'test-log-group',
      undefined,
      AggregationTemporality.DELTA,
      {}
    );

    await exporter['logStreamExistsPromise'];
  });

  afterEach(() => {
    sinon.restore();
  });

  it('TestInitialization', () => {
    /* Test exporter initialization. */
    expect(exporter['namespace']).toEqual('TestNamespace');
    expect(exporter['logGroupName']).not.toBeUndefined();
    expect(exporter['logStreamName']).not.toBeUndefined();
    expect(exporter['aggregationTemporality']).not.toBeUndefined();
  });

  it('TestInitializationWithCustomParams', async () => {
    /* Test exporter initialization with custom parameters. */

    const newExporter = new AWSCloudWatchEMFExporter(
      'CustomNamespace',
      'custom-log-group',
      'custom-stream',
      AggregationTemporality.DELTA,
      {}
    );

    expect(newExporter['namespace']).toEqual('CustomNamespace');
    expect(newExporter['logGroupName']).toEqual('custom-log-group');
    expect(newExporter['logStreamName']).toEqual('custom-stream');

    await newExporter['logStreamExistsPromise'];
  });

  it('TestGetUnitMapping', () => {
    /* Test unit mapping functionality. */
    // Test known units
    expect(
      exporter['getUnit']({
        name: 'testName',
        unit: 'ms',
        description: 'testDescription',
        timestamp: Date.now(),
        attributes: {},
      })
    ).toEqual('Milliseconds');
    expect(
      exporter['getUnit']({
        name: 'testName',
        unit: 's',
        description: 'testDescription',
        timestamp: Date.now(),
        attributes: {},
      })
    ).toEqual('Seconds');
    expect(
      exporter['getUnit']({
        name: 'testName',
        unit: 'By',
        description: 'testDescription',
        timestamp: Date.now(),
        attributes: {},
      })
    ).toEqual('Bytes');
    expect(
      exporter['getUnit']({
        name: 'testName',
        unit: '%',
        description: 'testDescription',
        timestamp: Date.now(),
        attributes: {},
      })
    ).toBeUndefined();

    // Test unknown unit
    expect(
      exporter['getUnit']({
        name: 'testName',
        unit: 'unknown',
        description: 'testDescription',
        timestamp: Date.now(),
        attributes: {},
      })
    ).toBeUndefined();

    // Test empty unit (should return undefined due to falsy check)
    expect(
      exporter['getUnit']({
        name: 'testName',
        unit: '',
        description: 'testDescription',
        timestamp: Date.now(),
        attributes: {},
      })
    ).toBeUndefined();
  });

  it('TestGetDimensionNames', () => {
    /* Test dimension names extraction. */
    const attributes = { 'service.name': 'test-service', env: 'prod', region: 'us-east-1' };

    const result = exporter['getDimensionNames'](attributes);

    // Should return all attribute keys
    expect(result).toContain('service.name');
    expect(result).toContain('env');
    expect(result).toContain('region');
  });

  it('TestGetAttributesKey', () => {
    /* Test attributes key generation. */
    const attributes = { service: 'test', env: 'prod' };

    const result = exporter['getAttributesKey'](attributes);

    // Should be a string representation of sorted attributes
    expect(typeof result).toEqual('string');
    expect(result).toContain('service');
    expect(result).toContain('test');
    expect(result).toContain('env');
    expect(result).toContain('prod');
  });

  it('TestGetAttributesKeyConsistent', () => {
    /* Test that attributes key generation is consistent. */
    // Same attributes in different order should produce same key
    const attrs1 = { b: '2', a: '1' };
    const attrs2 = { a: '1', b: '2' };

    const key1 = exporter['getAttributesKey'](attrs1);
    const key2 = exporter['getAttributesKey'](attrs2);

    expect(key1).toEqual(key2);
  });

  it('TestGroupByAttributesAndTimestamp', () => {
    /* Test grouping by attributes and timestamp. */
    const record: MetricRecord = {
      name: 'test_metric',
      unit: 'ms',
      description: 'test description',
      timestamp: Date.now(),
      attributes: { env: 'test' },
    };

    const result = exporter['groupByAttributesAndTimestamp'](record);

    // Should return a tuple with attributes key and timestamp
    expect(result.length).toEqual(2);
    expect(typeof result[0]).toEqual('string');
    expect(typeof result[1]).toEqual('number');
    expect(result[1]).toEqual(record.timestamp);
  });

  it('TestGenerateLogStreamName', () => {
    /* Test log stream name generation. */
    const name1 = exporter['generateLogStreamName']();
    const name2 = exporter['generateLogStreamName']();

    // Should generate unique names
    expect(name1).not.toEqual(name2);
    expect(name1.startsWith('otel-js-')).toBeTruthy();
    expect(name2.startsWith('otel-js-')).toBeTruthy();
  });

  it('TestNormalizeTimestamp', () => {
    /* Test timestamp normalization. */
    const timestampNs = 1609459200000000000; // 2021-01-01 00:00:00 in nanoseconds
    const expectedMs = 1609459200000; // Same time in milliseconds

    const result = exporter['normalizeTimestamp']([0, timestampNs]);
    expect(result).toEqual(expectedMs);
  });

  it('TestCreateMetricRecord', () => {
    /* Test metric record creation. */
    const record = exporter['createMetricRecord']('test_metric', 'Count', 'Test description', Date.now(), {});

    expect(record).not.toBeUndefined();
    expect(record).not.toBeUndefined();
    expect(record.name).toEqual('test_metric');
    expect(record.unit).toEqual('Count');
    expect(record.description).toEqual('Test description');
  });

  it('TestConvertGauge', () => {
    const dp: DataPoint<number> = {
      startTime: [0, 0],
      endTime: [1, 3_000_000],
      attributes: { key: 'value' },
      value: 42.5,
    };

    /* Test gauge conversion. */
    const metric: GaugeMetricData = {
      dataPointType: DataPointType.GAUGE,
      descriptor: {
        name: 'test_gauge_metric_data',
        unit: 'Count',
        description: 'Gauge description',
        valueType: ValueType.DOUBLE,
        type: InstrumentType.GAUGE,
      },
      dataPoints: [dp],
      aggregationTemporality: AggregationTemporality.DELTA,
    };

    const record = exporter['convertGauge'](metric, dp);

    expect(record).not.toBeUndefined();
    expect(record.name).toEqual('test_gauge_metric_data');
    expect(record.value).toEqual(42.5);
    expect(record.attributes).toEqual({ key: 'value' });
    expect(record.timestamp).toEqual(1003);
  });

  it('TestCreateEmfLog', () => {
    /* Test EMF log creation. */
    // Create test records
    const gaugeRecord: MetricRecord = {
      ...exporter['createMetricRecord']('gauge_metric', 'Count', 'Gauge', Date.now(), { env: 'test' }),
      value: 50.0,
    };

    // TODO: Test Sum metric record

    const records = [gaugeRecord];
    const resource = new Resource({ 'service.name': 'test-service' });

    const result = exporter['createEmfLog'](records, resource);

    expect(result).toHaveProperty('_aws');
    expect(result._aws.CloudWatchMetrics[0].Namespace).toEqual('TestNamespace');
    expect(result._aws.CloudWatchMetrics[0].Dimensions[0][0]).toEqual('env');
    expect(result._aws.CloudWatchMetrics[0].Metrics[0].Name).toEqual('gauge_metric');
    expect(result._aws.CloudWatchMetrics[0].Metrics[0].Unit).toEqual('Count');
    expect(result).toHaveProperty('Version', '1');
    expect(result['otel.resource.service.name']).toEqual('test-service'); // toHaveProperty() doesn't work with '.'
    expect(result).toHaveProperty('gauge_metric', 50);
    expect(result).toHaveProperty('env', 'test');

    // Sanity check that the result is JSON serializable, and doesn't throw error
    JSON.stringify(result);
  });

  it('TestExportSuccess', done => {
    /* Test successful export. */
    // Mock CloudWatch Logs client
    sinon.stub(exporter['logsClient'], 'putLogEvents').callsFake(input => {
      return { nextSequenceToken: '12345' };
    });

    // Create empty metrics data to test basic export flow
    const resourceMetricsData: ResourceMetrics = {
      resource: new Resource({}),
      scopeMetrics: [],
    };

    exporter.export(resourceMetricsData, result => {
      expect(result.code).toEqual(ExportResultCode.SUCCESS);
      done();
    });
  });

  it('TestExportSuccessWithManyResourceMetrics', done => {
    /* Test successful export. */
    // Mock CloudWatch Logs client
    sinon.stub(exporter['logsClient'], 'putLogEvents').callsFake(input => {
      return { nextSequenceToken: '12345' };
    });

    // Create empty metrics data to test basic export flow
    const resourceMetricsData: ResourceMetrics = {
      resource: new Resource({}),
      scopeMetrics: [
        {
          scope: {
            name: 'test',
          },
          metrics: [
            {
              dataPoints: [
                {
                  startTime: [0, 0],
                  endTime: [1, 1],
                  value: 3,
                  attributes: {},
                },
              ],
              dataPointType: DataPointType.GAUGE,
              descriptor: {
                name: 'descriptorName',
                description: 'descriptionName',
                unit: 'ms',
                type: InstrumentType.GAUGE,
                valueType: ValueType.INT,
              },
              aggregationTemporality: AggregationTemporality.DELTA,
            },
          ],
        },
        {
          scope: {
            name: 'test',
          },
          metrics: [
            {
              dataPoints: [
                {
                  startTime: [0, 0],
                  endTime: [1, 1],
                  value: 3,
                  attributes: {},
                },
              ],
              isMonotonic: true,
              dataPointType: DataPointType.SUM,
              descriptor: {
                name: 'descriptorName',
                description: 'descriptionName',
                unit: 'ms',
                type: InstrumentType.COUNTER,
                valueType: ValueType.INT,
              },
              aggregationTemporality: AggregationTemporality.DELTA,
            },
          ],
        },
        {
          scope: {
            name: 'test',
          },
          metrics: [
            {
              dataPoints: [
                {
                  startTime: [0, 0],
                  endTime: [1, 1],
                  value: {
                    buckets: {
                      boundaries: [],
                      counts: [],
                    },
                    sum: 7,
                    count: 3,
                    min: 1,
                    max: 5,
                  },
                  attributes: {},
                },
              ],
              dataPointType: DataPointType.HISTOGRAM,
              descriptor: {
                name: 'descriptorName',
                description: 'descriptionName',
                unit: 'ms',
                type: InstrumentType.HISTOGRAM,
                valueType: ValueType.INT,
              },
              aggregationTemporality: AggregationTemporality.DELTA,
            },
          ],
        },
        {
          scope: {
            name: 'test',
          },
          metrics: [
            {
              dataPoints: [
                {
                  startTime: [0, 0],
                  endTime: [1, 1],
                  value: {
                    count: 2,
                    sum: 8,
                    scale: 1,
                    zeroCount: 0,
                    positive: {
                      offset: 0,
                      bucketCounts: [1, 2],
                    },
                    negative: {
                      offset: 0,
                      bucketCounts: [1, 2],
                    },
                    min: 2,
                    max: 6,
                  },
                  attributes: {},
                },
              ],
              dataPointType: DataPointType.EXPONENTIAL_HISTOGRAM,
              descriptor: {
                name: 'descriptorName',
                description: 'descriptionName',
                unit: 'ms',
                type: InstrumentType.HISTOGRAM,
                valueType: ValueType.INT,
              },
              aggregationTemporality: AggregationTemporality.DELTA,
            },
          ],
        },
      ],
    };

    exporter.export(resourceMetricsData, result => {
      expect(result.code).toEqual(ExportResultCode.SUCCESS);
      done();
    });
  });

  it('TestExportFailure', done => {
    /* Test export failure handling. */
    // Create metrics data that will cause an exception during iteration
    const metricsData: ResourceMetrics = {
      resource: new Resource({}),
      scopeMetrics: [undefined as any], // will cause an error to throw
    };

    exporter.export(metricsData, result => {
      expect(result.code).toEqual(ExportResultCode.FAILED);
      done();
    });
  });

  it('TestForceFlushWithPendingEvents', async () => {
    /* Test force flush functionality with pending events. */

    const sendLogBatchStub = sinon.stub(exporter, <any>'sendLogBatch');

    // Create a batch with events
    exporter['eventBatch'] = exporter['createEventBatch']();
    exporter['eventBatch']['logEvents'] = [{ message: 'test', timestamp: Date.now() }];

    await expect(exporter.forceFlush()).resolves.not.toThrow();
    sinon.assert.calledOnce(sendLogBatchStub);
  });

  it('TestForceFlushNoPendingEvents', async () => {
    /* Test force flush functionality with no pending events. */
    // No batch exists
    expect(exporter['eventBatch']).toBeUndefined();

    await expect(exporter.forceFlush()).resolves.not.toThrow();
  });

  it('TestShutdown', async () => {
    /* Test shutdown functionality. */

    const forceFlushStub = sinon.stub(exporter, 'forceFlush');

    // Ensure this call doesn't reject
    await exporter.shutdown();

    sinon.assert.calledOnce(forceFlushStub);
  });

  it('TestSelectAggregationTemporality', async () => {
    // Default is AggregationTemporality.DELTA
    expect(exporter.selectAggregationTemporality(InstrumentType.HISTOGRAM)).toEqual(AggregationTemporality.DELTA);
  });

  it('TestSelectAggregation', async () => {
    // Should return ExponentialHistogram Aggregation for HISTOGRAM InstrumentType
    expect(exporter.selectAggregation(InstrumentType.HISTOGRAM)).toEqual(Aggregation.ExponentialHistogram());

    // Should return Default Aggregation for other InstrumentType
    expect(exporter.selectAggregation(InstrumentType.COUNTER)).toEqual(Aggregation.Default());
    expect(exporter.selectAggregation(InstrumentType.GAUGE)).toEqual(Aggregation.Default());
  });

  it('TestEnsureLogGroupExists', async () => {
    exporter['logGroupName'] = 'groupName';

    (exporter['logsClient'].createLogGroup as any).callsFake(async () => {
      const err = new Error('SpecifiedError');
      err.name = 'ResourceAlreadyExistsException';
      throw err;
    });
    await exporter['ensureLogGroupExists']();

    (exporter['logsClient'].createLogGroup as any).callsFake(async () => {
      throw Error('SomeError');
    });
    await expect(async () => {
      return exporter['ensureLogGroupExists']();
    }).rejects.toThrow('SomeError');
  });

  it('TestEnsureLogStreamExists', async () => {
    exporter['logGroupName'] = 'groupName';
    exporter['logStreamName'] = 'streamName';

    (exporter['logsClient'].createLogStream as any).callsFake(async () => {
      const err = new Error('SpecifiedError');
      err.name = 'ResourceAlreadyExistsException';
      throw err;
    });
    await exporter['ensureLogStreamExists']();

    (exporter['logsClient'].createLogStream as any).callsFake(async () => {
      throw Error('SomeError');
    });
    await expect(async () => {
      return exporter['ensureLogStreamExists']();
    }).rejects.toThrow('SomeError');
  });
});
