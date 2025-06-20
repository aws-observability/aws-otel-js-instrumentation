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
import { CloudWatchLogs } from '@aws-sdk/client-cloudwatch-logs';
import {
  AWSCloudWatchEMFExporter,
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

  it('TestForceF', async () => {
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
