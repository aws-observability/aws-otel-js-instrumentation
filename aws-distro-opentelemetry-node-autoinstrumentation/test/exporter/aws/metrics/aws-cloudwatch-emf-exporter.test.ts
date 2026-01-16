// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { applyInstrumentationPatches } from '../../../../src/patches/instrumentation-patch';

// Central location to register AWS SDK instrumentation for testing for all tests in this project.
// This block of code should be run at the beginning of the first test file that performs tests on AWS SDK.
const instrumentations: AwsInstrumentation[] = [new AwsInstrumentation()];
applyInstrumentationPatches(instrumentations);
process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'http';
registerInstrumentationTesting(instrumentations[0]);

import { Attributes, ValueType } from '@opentelemetry/api';
import {
  Aggregation,
  AggregationTemporality,
  DataPoint,
  DataPointType,
  ExponentialHistogram,
  ExponentialHistogramMetricData,
  GaugeMetricData,
  Histogram,
  HistogramMetricData,
  InstrumentType,
  ResourceMetrics,
  SumMetricData,
} from '@opentelemetry/sdk-metrics';
import { ExportResultCode } from '@opentelemetry/core';
import { expect } from 'expect';
import * as sinon from 'sinon';
import { MetricRecord } from '../../../../src/exporter/aws/metrics/emf-exporter-base';
import { Resource } from '@opentelemetry/resources';
import { LogEventBatch } from '../../../../src/exporter/aws/metrics/cloudwatch-logs-client';
import { AWSCloudWatchEMFExporter } from '../../../../src/exporter/aws/metrics/aws-cloudwatch-emf-exporter';

describe('TestAWSCloudWatchEMFExporter', () => {
  let exporter: AWSCloudWatchEMFExporter;
  const { CloudWatchLogs } = require('@aws-sdk/client-cloudwatch-logs');

  beforeEach(() => {
    /* Set up test fixtures. */
    // Clean up env var before each test
    delete process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'];

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

    exporter = new AWSCloudWatchEMFExporter('TestNamespace', 'test-log-group', undefined, undefined, undefined, {});
  });

  afterEach(() => {
    sinon.restore();
  });

  it('TestInitialization', () => {
    /* Test exporter initialization. */
    expect(exporter['namespace']).toEqual('TestNamespace');
    expect(exporter['logClient']).not.toBeUndefined();
    expect(exporter['aggregationTemporalitySelector']).not.toBeUndefined();
    expect(exporter['aggregationSelector']).not.toBeUndefined();
  });

  it('TestInitializationWithCustomParams', async () => {
    /* Test exporter initialization with custom parameters. */

    const newExporter = new AWSCloudWatchEMFExporter(
      'CustomNamespace',
      'custom-log-group',
      'custom-stream',
      () => AggregationTemporality.DELTA,
      () => Aggregation.Default(),
      {}
    );

    expect(newExporter['namespace']).toEqual('CustomNamespace');
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
    const attributes: Attributes = { 'service.name': 'test-service', env: 'prod', region: 'us-east-1' };

    const result = exporter['getDimensionNames'](attributes);

    // Should return all attribute keys
    expect(result).toContain('service.name');
    expect(result).toContain('env');
    expect(result).toContain('region');
  });

  it('TestGetAttributesKey', () => {
    /* Test attributes key generation. */
    const attributes: Attributes = { service: 'test', env: 'prod' };

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
    const attrs1: Attributes = { b: '2', a: '1' };
    const attrs2: Attributes = { a: '1', b: '2' };

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

  it('TestConvertGaugeAndSum', () => {
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

    const record = exporter['convertGaugeAndSum'](metric, dp);

    expect(record).not.toBeUndefined();
    expect(record.name).toEqual('test_gauge_metric_data');
    expect(record.value).toEqual(42.5);
    expect(record.attributes).toEqual({ key: 'value' });
    expect(record.timestamp).toEqual(1003);
  });

  it('TestConvertSum', () => {
    /* Test sum conversion. */
    const dp: DataPoint<number> = {
      startTime: [0, 0],
      endTime: [1, 3_000_000],
      attributes: { env: 'test' },
      value: 100.0,
    };

    /* Test sum conversion. */
    const metric: SumMetricData = {
      dataPointType: DataPointType.SUM,
      descriptor: {
        name: 'sum_metric',
        unit: 'Count',
        description: 'Sum description',
        valueType: ValueType.DOUBLE,
        type: InstrumentType.COUNTER,
      },
      dataPoints: [dp],
      aggregationTemporality: AggregationTemporality.DELTA,
      isMonotonic: true,
    };

    const record = exporter['convertGaugeAndSum'](metric, dp);

    expect(record).not.toBeUndefined();
    expect(record.name).toEqual('sum_metric');
    expect(record.value).toEqual(100.0);
    expect(record.attributes).toEqual({ env: 'test' });
    expect(record.timestamp).toEqual(1003);
  });

  it('TestConvertHistogram', () => {
    /* Test histogram conversion. */
    const dp: DataPoint<Histogram> = {
      startTime: [0, 0],
      endTime: [1, 3_000_000],
      attributes: { region: 'us-east-1' },
      value: {
        count: 10,
        sum: 150.0,
        min: 5.0,
        max: 25.0,
        buckets: {
          boundaries: [],
          counts: [],
        },
      },
    };

    /* Test histogram conversion. */
    const metric: HistogramMetricData = {
      dataPointType: DataPointType.HISTOGRAM,
      descriptor: {
        name: 'histogram_metric',
        unit: 'ms',
        description: 'Histogram description',
        valueType: ValueType.DOUBLE,
        type: InstrumentType.HISTOGRAM,
      },
      dataPoints: [dp],
      aggregationTemporality: AggregationTemporality.DELTA,
    };

    const record = exporter['convertHistogram'](metric, dp);

    expect(record).not.toBeUndefined();
    expect(record.name).toEqual('histogram_metric');
    expect(record).toHaveProperty('histogramData');

    const expectedValue = {
      Count: 10,
      Sum: 150.0,
      Min: 5.0,
      Max: 25.0,
    };
    expect(record.histogramData).toEqual(expectedValue);
    expect(record.attributes).toEqual({ region: 'us-east-1' });
    expect(record.timestamp).toEqual(1003);
  });

  it('TestConvertExpHistogram', () => {
    /* Test exponential histogram conversion. */
    const dp: DataPoint<ExponentialHistogram> = {
      startTime: [0, 0],
      endTime: [1, 3_000_000],
      attributes: { service: 'api' },
      value: {
        count: 8,
        sum: 64.0,
        min: 2.0,
        max: 32.0,
        scale: 1,
        zeroCount: 1,
        positive: {
          offset: 1,
          bucketCounts: [],
        },
        negative: {
          offset: 2,
          bucketCounts: [],
        },
      },
    };

    /* Test exponential histogram conversion. */
    const metric: ExponentialHistogramMetricData = {
      dataPointType: DataPointType.EXPONENTIAL_HISTOGRAM,
      descriptor: {
        name: 'exp_histogram_metric',
        unit: 's',
        description: 'Exponential histogram description',
        valueType: ValueType.DOUBLE,
        type: InstrumentType.HISTOGRAM,
      },
      dataPoints: [dp],
      aggregationTemporality: AggregationTemporality.DELTA,
    };

    const record = exporter['convertExpHistogram'](metric, dp);

    expect(record).not.toBeUndefined();
    expect(record.name).toEqual('exp_histogram_metric');
    expect(record).toHaveProperty('expHistogramData');

    const expData = record.expHistogramData;
    expect(expData).toHaveProperty('Values');
    expect(expData).toHaveProperty('Counts');
    expect(expData?.['Count']).toEqual(8);
    expect(expData?.['Sum']).toEqual(64.0);
    expect(expData?.['Min']).toEqual(2.0);
    expect(expData?.['Max']).toEqual(32.0);
    expect(record.attributes).toEqual({ service: 'api' });
    expect(record.timestamp).toEqual(1003);
  });

  it('TestCreateEmfLog', () => {
    /* Test EMF log creation. */
    // Create test records
    const gaugeRecord: MetricRecord = {
      ...exporter['createMetricRecord']('gauge_metric', 'Count', 'Gauge', Date.now(), { env: 'test' }),
      value: 50.0,
    };

    const sumRecord: MetricRecord = {
      ...exporter['createMetricRecord']('sum_metric', 'Count', 'Sum', Date.now(), { env: 'test' }),
      value: 100.0,
    };

    const records = [gaugeRecord, sumRecord];
    const resource = new Resource({ 'service.name': 'test-service' });

    const result = exporter['createEmfLog'](records, resource);

    expect(result).toHaveProperty('_aws');
    expect(result._aws.CloudWatchMetrics[0].Namespace).toEqual('TestNamespace');
    expect(result._aws.CloudWatchMetrics[0].Dimensions![0][0]).toEqual('env');
    expect(result._aws.CloudWatchMetrics[0].Metrics[0].Name).toEqual('gauge_metric');
    expect(result._aws.CloudWatchMetrics[0].Metrics[0].Unit).toEqual('Count');
    expect(result._aws.CloudWatchMetrics[0].Metrics[1].Name).toEqual('sum_metric');
    expect(result._aws.CloudWatchMetrics[0].Metrics[1].Unit).toEqual('Count');
    expect(result).toHaveProperty('Version', '1');
    expect(result['otel.resource.service.name']).toEqual('test-service'); // toHaveProperty() doesn't work with '.'
    expect(result).toHaveProperty('gauge_metric', 50);
    expect(result).toHaveProperty('sum_metric', 100);
    expect(result).toHaveProperty('env', 'test');

    // Sanity check that the result is JSON serializable, and doesn't throw error
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('TestExportSuccess', async () => {
    /* Test successful export. */
    // Mock CloudWatch Logs client
    sinon.stub(exporter['logClient'], 'sendLogEvent').resolves();

    // Create empty metrics data to test basic export flow
    const resourceMetricsData = {
      resource: new Resource({}),
      scopeMetrics: [],
    };

    await new Promise<void>(resolve => {
      exporter.export(resourceMetricsData, result => {
        expect(result.code).toEqual(ExportResultCode.SUCCESS);
        resolve();
      });
    });
  });

  it('TestExportSuccessWithManyResourceMetrics', async () => {
    /* Test successful export with many resource metrics. */
    // Mock CloudWatch Logs client
    sinon.stub(exporter['logClient'], 'sendLogEvent').resolves();

    // Create metrics data to test export flow
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

    await new Promise<void>(resolve => {
      exporter.export(resourceMetricsData, result => {
        expect(result.code).toEqual(ExportResultCode.SUCCESS);
        resolve();
      });
    });
  });

  it('TestExportFailure', async () => {
    /* Test export failure handling. */
    // Create metrics data that will cause an exception during iteration
    const metricsData: any = {
      resource: new Resource({}),
      scopeMetrics: [undefined], // will cause an error to throw
    };

    await new Promise<void>(resolve => {
      exporter.export(metricsData, result => {
        expect(result.code).toEqual(ExportResultCode.FAILED);
        resolve();
      });
    });
  });

  it('TestExportCallsSendLogBatchWithExpectedInput', done => {
    // Disable Application Signals dimensions for this test
    process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'false';

    const timeInSeconds = Math.round(Date.now() / 1000);

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
                  startTime: [timeInSeconds, 0],
                  endTime: [timeInSeconds, 1],
                  value: 3,
                  attributes: { uniqueKey1: 'uniqueValue1' },
                },
                {
                  startTime: [timeInSeconds, 1],
                  endTime: [timeInSeconds, 2],
                  value: 9,
                  attributes: { uniqueKey2: 'uniqueValue2' },
                },
                {
                  startTime: [timeInSeconds, 2],
                  endTime: [timeInSeconds, 3],
                  value: 5,
                  attributes: { uniqueKey3: 'uniqueValue3' },
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
      ],
    };

    const logClientSendLogBatchStub = sinon.stub(exporter['logClient'], 'sendLogBatch' as any);
    sinon.stub(exporter['logClient'], 'eventBatchExceedsLimit' as any).returns(true);

    exporter.export(resourceMetricsData, result => {
      expect(result.code).toEqual(ExportResultCode.SUCCESS);

      sinon.assert.calledThrice(logClientSendLogBatchStub);
      const call1Args = logClientSendLogBatchStub.getCall(0).args[0] as LogEventBatch;
      const call2Args = logClientSendLogBatchStub.getCall(1).args[0] as LogEventBatch;
      const call3Args = logClientSendLogBatchStub.getCall(2).args[0] as LogEventBatch;

      expect(call1Args.logEvents.length).toEqual(0);
      expect(call2Args.logEvents[0].message).toMatch(
        /^\{"_aws":\{"Timestamp":\d+,"CloudWatchMetrics":\[\{"Namespace":"TestNamespace","Metrics":\[\{"Name":"descriptorName","Unit":"Milliseconds"\}\],"Dimensions":\[\["uniqueKey1"\]\]\}\]},"Version":"1","descriptorName":3,"uniqueKey1":"uniqueValue1"\}$/
      );
      expect(call3Args.logEvents[0].message).toMatch(
        /^\{"_aws":\{"Timestamp":\d+,"CloudWatchMetrics":\[\{"Namespace":"TestNamespace","Metrics":\[\{"Name":"descriptorName","Unit":"Milliseconds"\}\],"Dimensions":\[\["uniqueKey2"\]\]\}\]},"Version":"1","descriptorName":9,"uniqueKey2":"uniqueValue2"\}$/
      );
      done();
    });
  });

  it('TestForceFlushWithPendingEvents', async () => {
    /* Test force flush functionality with pending events. */
    const flushPendingEventsStub = sinon.stub(exporter['logClient'], 'flushPendingEvents').resolves();

    await exporter.forceFlush();

    expect(flushPendingEventsStub.calledOnce).toBeTruthy();
  });

  it('TestShutdown', async () => {
    /* Test shutdown functionality. */
    const forceFlushStub = sinon.stub(exporter, 'forceFlush').resolves();

    await exporter.shutdown();

    expect(forceFlushStub.calledOnce).toBeTruthy();
  });

  it('TestSelectAggregationTemporality', () => {
    // Default is AggregationTemporality.DELTA
    expect(exporter.selectAggregationTemporality(InstrumentType.HISTOGRAM)).toEqual(AggregationTemporality.DELTA);
  });

  it('TestSelectAggregation', () => {
    // Should return ExponentialHistogram Aggregation for HISTOGRAM InstrumentType
    expect(exporter.selectAggregation(InstrumentType.HISTOGRAM)).toEqual(Aggregation.ExponentialHistogram());

    // Should return Default Aggregation for other InstrumentType
    expect(exporter.selectAggregation(InstrumentType.COUNTER)).toEqual(Aggregation.Default());
    expect(exporter.selectAggregation(InstrumentType.GAUGE)).toEqual(Aggregation.Default());
  });

  it('TestCreateEmfLogWithResource', () => {
    /* Test EMF log creation with resource attributes. */
    // Create test records
    const gaugeRecord: MetricRecord = {
      ...exporter['createMetricRecord']('gauge_metric', 'Count', 'Gauge', Date.now(), { env: 'test', service: 'api' }),
      value: 50.0,
    };

    const records = [gaugeRecord];
    const resource = new Resource({ 'service.name': 'test-service', 'service.version': '1.0.0' });

    const result = exporter['createEmfLog'](records, resource, 1234567890);

    // Verify EMF log structure
    expect(result).toHaveProperty('_aws');
    expect(result._aws).toHaveProperty('CloudWatchMetrics');
    expect(result._aws.Timestamp).toEqual(1234567890);
    expect(result.Version).toEqual('1');

    // Check resource attributes are prefixed
    expect(result['otel.resource.service.name']).toEqual('test-service');
    expect(result['otel.resource.service.version']).toEqual('1.0.0');

    // Check metric attributes
    expect(result.env).toEqual('test');
    expect(result.service).toEqual('api');

    // Check metric value
    expect(result.gauge_metric).toEqual(50.0);

    // Check CloudWatch metrics structure
    const cwMetrics = result._aws.CloudWatchMetrics[0];
    expect(cwMetrics.Namespace).toEqual('TestNamespace');
    expect(cwMetrics).toHaveProperty('Dimensions');
    expect(cwMetrics.Dimensions![0]).toContain('env');
    expect(cwMetrics.Dimensions![0]).toContain('service');
    expect(cwMetrics.Metrics[0].Name).toEqual('gauge_metric');
  });

  it('TestCreateEmfLogWithoutDimensions', () => {
    /* Test EMF log creation with metrics but no dimensions. */
    // Disable Application Signals dimensions for this test
    process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'false';

    // Create test record with empty attributes (no dimensions)
    const gaugeRecord: MetricRecord = {
      ...exporter['createMetricRecord']('gauge_metric', 'Count', 'Gauge', Date.now(), {}),
      value: 75.0,
    };

    const records = [gaugeRecord];
    const resource = new Resource({ 'service.name': 'test-service', 'service.version': '1.0.0' });

    const result = exporter['createEmfLog'](records, resource, 1234567890);

    // Verify EMF log structure
    expect(result).toHaveProperty('_aws');
    expect(result._aws).toHaveProperty('CloudWatchMetrics');
    expect(result._aws.Timestamp).toEqual(1234567890);
    expect(result.Version).toEqual('1');

    // Check resource attributes are prefixed
    expect(result['otel.resource.service.name']).toEqual('test-service');
    expect(result['otel.resource.service.version']).toEqual('1.0.0');

    // Check metric value
    expect(result.gauge_metric).toEqual(75.0);

    // Check CloudWatch metrics structure
    const cwMetrics = result._aws.CloudWatchMetrics[0];
    expect(cwMetrics.Namespace).toEqual('TestNamespace');
    expect(cwMetrics).not.toHaveProperty('Dimensions');
    expect(cwMetrics.Metrics[0].Name).toEqual('gauge_metric');
  });

  it('TestCreateEmfLogSkipsEmptyMetricNames', () => {
    /* Test that EMF log creation skips records with empty metric names. */
    // Create a record with no metric name
    const recordWithoutName: MetricRecord = {
      name: '',
      unit: '',
      description: '',
      timestamp: Date.now(),
      attributes: { key: 'value' },
      value: 10.0,
    };

    // Create a record with valid metric name
    const validRecord: MetricRecord = {
      ...exporter['createMetricRecord']('valid_metric', 'Count', 'Valid metric', Date.now(), { key: 'value' }),
      value: 20.0,
    };

    const records = [recordWithoutName, validRecord];
    const resource = new Resource({ 'service.name': 'test-service' });

    const result = exporter['createEmfLog'](records, resource, 1234567890);

    // Only the valid record should be processed
    expect(result).toHaveProperty('valid_metric', 20.0);

    // Check that only the valid metric is in the definitions (empty names are skipped)
    const cwMetrics = result._aws.CloudWatchMetrics[0];
    expect(cwMetrics.Metrics.length).toEqual(1);
    // Ensure our valid metric is present
    const metricNames = cwMetrics.Metrics.map(m => m.Name);
    expect(metricNames).toContain('valid_metric');
  });

  it('TestSendLogEvent', async () => {
    /* Test that sendLogEvent method exists and can be called. */
    // Just test that the method exists and doesn't crash with basic input
    const logEvent = { message: 'test message', timestamp: 1234567890 };

    // Mock the log client to avoid actual AWS calls
    const mockSendLogEvent = sinon.stub(exporter['logClient'], 'sendLogEvent').resolves();

    // Should not throw an exception
    await expect(exporter['sendLogEvent'](logEvent)).resolves.not.toThrow();
    expect(mockSendLogEvent.calledOnce).toBeTruthy();
    expect(mockSendLogEvent.calledWith(logEvent)).toBeTruthy();
  });

  describe('Application Signals EMF Dimensions', () => {
    beforeEach(() => {
      // Clean up env var before each test
      delete process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'];
    });

    it('TestDimensionsNotAddedWhenFeatureDisabled', () => {
      /* Test that Service/Environment dimensions are NOT added when feature is explicitly disabled. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'false';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({ 'service.name': 'my-service' });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      // Should NOT have Service or Environment dimensions
      expect(result).not.toHaveProperty('Service');
      expect(result).not.toHaveProperty('Environment');
      const cwMetrics = result._aws.CloudWatchMetrics[0];
      expect(cwMetrics.Dimensions![0]).not.toContain('Service');
      expect(cwMetrics.Dimensions![0]).not.toContain('Environment');
    });

    it('TestDimensionsAddedByDefault', () => {
      /* Test that Service/Environment dimensions ARE added by default when env var is not set. */
      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({ 'service.name': 'my-service', 'deployment.environment': 'production' });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      // Should have Service and Environment dimensions by default
      expect(result).toHaveProperty('Service', 'my-service');
      expect(result).toHaveProperty('Environment', 'production');
      const cwMetrics = result._aws.CloudWatchMetrics[0];
      expect(cwMetrics.Dimensions![0]).toContain('Service');
      expect(cwMetrics.Dimensions![0]).toContain('Environment');
    });

    it('TestDimensionsAddedWhenEnvVarEnabled', () => {
      /* Test that Service/Environment dimensions ARE added when env var is enabled. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({ 'service.name': 'my-service', 'deployment.environment': 'production' });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      // Should have Service and Environment dimensions
      expect(result).toHaveProperty('Service', 'my-service');
      expect(result).toHaveProperty('Environment', 'production');
      const cwMetrics = result._aws.CloudWatchMetrics[0];
      expect(cwMetrics.Dimensions![0]).toContain('Service');
      expect(cwMetrics.Dimensions![0]).toContain('Environment');
      expect(cwMetrics.Dimensions![0]).toContain('env');
      // Original attributes come first, then Application Signals dimensions
      expect(cwMetrics.Dimensions![0][0]).toEqual('env');
      expect(cwMetrics.Dimensions![0]).toContain('Service');
      expect(cwMetrics.Dimensions![0]).toContain('Environment');
    });

    it('TestServiceDimensionNotOverwrittenCaseInsensitive', () => {
      /* Test that user-set Service dimension (any case) is NOT overwritten. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      // User sets 'service' (lowercase) as an attribute
      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { service: 'user-service' }),
        value: 50.0,
      };

      const resource = new Resource({ 'service.name': 'resource-service' });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      // Should NOT add 'Service' dimension since 'service' already exists
      expect(result).not.toHaveProperty('Service');
      expect(result).toHaveProperty('service', 'user-service');
      // Environment should still be added
      expect(result).toHaveProperty('Environment', 'generic:default');
    });

    it('TestEnvironmentDimensionNotOverwrittenCaseInsensitive', () => {
      /* Test that user-set Environment dimension (any case) is NOT overwritten. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      // User sets 'ENVIRONMENT' (uppercase) as an attribute
      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { ENVIRONMENT: 'user-env' }),
        value: 50.0,
      };

      const resource = new Resource({ 'service.name': 'my-service', 'deployment.environment': 'production' });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      // Should NOT add 'Environment' dimension since 'ENVIRONMENT' already exists
      expect(result).not.toHaveProperty('Environment');
      expect(result).toHaveProperty('ENVIRONMENT', 'user-env');
      // Service should still be added
      expect(result).toHaveProperty('Service', 'my-service');
    });

    it('TestServiceFallbackToUnknownService', () => {
      /* Test that Service falls back to UnknownService when resource has no service.name. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      // Resource without service.name
      const resource = new Resource({});
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Service', 'UnknownService');
    });

    it('TestServiceFallbackWhenUnknownServicePattern', () => {
      /* Test that Service falls back to UnknownService when resource has OTel default service name. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      // Resource with OTel default service name pattern
      const { defaultServiceName } = require('@opentelemetry/resources');
      const resource = new Resource({ 'service.name': defaultServiceName() });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Service', 'UnknownService');
    });

    it('TestEnvironmentFallbackToGenericDefault', () => {
      /* Test that Environment falls back to generic:default when no platform is detected. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      // Resource without deployment.environment and no cloud.platform
      const resource = new Resource({ 'service.name': 'my-service' });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Environment', 'generic:default');
    });

    it('TestEnvironmentExtractedFromResource', () => {
      /* Test that Environment is extracted from deployment.environment resource attribute. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({ 'service.name': 'my-service', 'deployment.environment': 'staging' });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Environment', 'staging');
    });

    it('TestEnvironmentNameTakesPrecedenceOverEnvironment', () => {
      /* Test that deployment.environment.name takes precedence over deployment.environment. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({
        'service.name': 'my-service',
        'deployment.environment': 'old-env',
        'deployment.environment.name': 'new-env',
      });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Environment', 'new-env');
    });

    it('TestDimensionsAddedAlongsideExisting', () => {
      /* Test that Service and Environment are added alongside existing dimensions. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { existing_dim: 'value' }),
        value: 50.0,
      };

      const resource = new Resource({ 'service.name': 'my-service', 'deployment.environment': 'prod' });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      const cwMetrics = result._aws.CloudWatchMetrics[0];
      // All three dimensions should be present
      expect(cwMetrics.Dimensions![0]).toContain('Service');
      expect(cwMetrics.Dimensions![0]).toContain('Environment');
      expect(cwMetrics.Dimensions![0]).toContain('existing_dim');
    });

    it('TestEnvVarCaseInsensitive', () => {
      /* Test that env var value is case-insensitive (TRUE, True, true all work). */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'TRUE';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({ 'service.name': 'my-service' });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Service', 'my-service');
      expect(result).toHaveProperty('Environment', 'generic:default');
    });

    it('TestLambdaPlatformDefault', () => {
      /* Test that Lambda platform uses lambda:default. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({
        'service.name': 'my-service',
        'cloud.platform': 'aws_lambda',
      });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Environment', 'lambda:default');
    });

    it('TestEC2PlatformDefault', () => {
      /* Test that EC2 platform uses ec2:default. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({
        'service.name': 'my-service',
        'cloud.platform': 'aws_ec2',
      });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Environment', 'ec2:default');
    });

    it('TestECSPlatformDefault', () => {
      /* Test that ECS platform uses ecs:default. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({
        'service.name': 'my-service',
        'cloud.platform': 'aws_ecs',
      });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Environment', 'ecs:default');
    });

    it('TestEKSPlatformDefault', () => {
      /* Test that EKS platform uses eks:default. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({
        'service.name': 'my-service',
        'cloud.platform': 'aws_eks',
      });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Environment', 'eks:default');
    });

    it('TestExplicitEnvironmentTakesPrecedenceOverPlatformDefault', () => {
      /* Test that explicit deployment.environment takes precedence over platform default. */
      process.env['OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS'] = 'true';

      const gaugeRecord: MetricRecord = {
        ...exporter['createMetricRecord']('test_metric', 'Count', 'Test', Date.now(), { env: 'test' }),
        value: 50.0,
      };

      const resource = new Resource({
        'service.name': 'my-service',
        'cloud.platform': 'aws_lambda',
        'deployment.environment': 'production',
      });
      const result = exporter['createEmfLog']([gaugeRecord], resource, 1234567890);

      expect(result).toHaveProperty('Environment', 'production');
    });
  });
});
