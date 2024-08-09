// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Attributes,
  Context,
  Histogram,
  HrTime,
  Meter,
  SpanContext,
  SpanKind,
  SpanStatus,
  SpanStatusCode,
  TraceFlags,
  isSpanContextValid,
} from '@opentelemetry/api';
import { InstrumentationLibrary, hrTimeDuration } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import { SEMATTRS_HTTP_STATUS_CODE } from '@opentelemetry/semantic-conventions';
import expect from 'expect';
import * as sinon from 'sinon';
import { AWS_ATTRIBUTE_KEYS } from '../src/aws-attribute-keys';
import { AwsMetricAttributeGenerator } from '../src/aws-metric-attribute-generator';
import { AwsSpanMetricsProcessor } from '../src/aws-span-metrics-processor';
import { AwsSpanProcessingUtil } from '../src/aws-span-processing-util';
import {
  AttributeMap,
  DEPENDENCY_METRIC,
  MetricAttributeGenerator,
  SERVICE_METRIC,
} from '../src/metric-attribute-generator';

const INVALID_SPAN_CONTEXT: SpanContext = {
  traceId: 'INVALID_TRACE_ID',
  spanId: 'INVALID_SPAN_ID',
  traceFlags: TraceFlags.NONE,
};

describe('AwsSpanMetricsProcessorTest', () => {
  // Test constants
  const CONTAINS_ATTRIBUTES: boolean = true;
  const CONTAINS_NO_ATTRIBUTES: boolean = false;
  const TEST_LATENCY_MILLIS: number = 150.0;
  const TEST_LATENCY_NANOS: number = 150_000_000;

  // Resource is not mockable, but tests can safely rely on an empty resource.
  const testResource: Resource = Resource.empty();

  // Useful enum for indicating expected HTTP status code-related metrics
  enum ExpectedStatusMetric {
    ERROR,
    FAULT,
    NEITHER,
  }

  // Mocks required for tests.
  let errorHistogramMock: Histogram;
  let faultHistogramMock: Histogram;
  let latencyHistogramMock: Histogram;

  let errorHistogramMockRecord: sinon.SinonStub<
    [value: number, attributes?: Attributes | undefined, context?: Context | undefined],
    void
  >;
  let faultHistogramMockRecord: sinon.SinonStub<
    [value: number, attributes?: Attributes | undefined, context?: Context | undefined],
    void
  >;
  let latencyHistogramMockRecord: sinon.SinonStub<
    [value: number, attributes?: Attributes | undefined, context?: Context | undefined],
    void
  >;

  let generatorMock: MetricAttributeGenerator;
  let awsSpanMetricsProcessor: AwsSpanMetricsProcessor;

  beforeEach(() => {
    const meterProvider: Meter = new MeterProvider({}).getMeter('testMeter');

    errorHistogramMock = meterProvider.createHistogram('Error');
    faultHistogramMock = meterProvider.createHistogram('Fault');
    latencyHistogramMock = meterProvider.createHistogram('Latency');
    errorHistogramMockRecord = sinon.stub(errorHistogramMock, 'record');
    faultHistogramMockRecord = sinon.stub(faultHistogramMock, 'record');
    latencyHistogramMockRecord = sinon.stub(latencyHistogramMock, 'record');

    generatorMock = new AwsMetricAttributeGenerator();

    awsSpanMetricsProcessor = AwsSpanMetricsProcessor.create(
      errorHistogramMock,
      faultHistogramMock,
      latencyHistogramMock,
      generatorMock,
      testResource
    );
  });

  it('testStartDoesNothingToSpan', () => {
    const parentContextMock: Context = {
      getValue: (key: symbol) => 'unknown',
      setValue: (key: symbol, value: unknown) => parentContextMock,
      deleteValue: (key: symbol) => parentContextMock,
    };
    const parentContextMockGetValue: sinon.SinonStub<[key: symbol], unknown> = sinon.stub(
      parentContextMock,
      'getValue'
    );
    const parentContextMockSetValue: sinon.SinonStub<[key: symbol, value: unknown], Context> = sinon.stub(
      parentContextMock,
      'setValue'
    );
    const parentContextMockDeleteValue: sinon.SinonStub<[key: symbol], Context> = sinon.stub(
      parentContextMock,
      'deleteValue'
    );
    const spanMock: Span = sinon.createStubInstance(Span);

    awsSpanMetricsProcessor.onStart(spanMock, parentContextMock);
    sinon.assert.notCalled(parentContextMockGetValue);
    sinon.assert.notCalled(parentContextMockSetValue);
    sinon.assert.notCalled(parentContextMockDeleteValue);
  });

  it('testTearDown', async () => {
    expect(awsSpanMetricsProcessor.shutdown()).resolves.not.toThrow();
    expect(awsSpanMetricsProcessor.forceFlush()).resolves.not.toThrow();
  });

  /**
   * Tests starting with testOnEndMetricsGeneration are testing the logic in
   * AwsSpanMetricsProcessor's onEnd method pertaining to metrics generation.
   */
  it('testOnEndMetricsGenerationWithoutSpanAttributes', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(spanAttributes);
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    verifyHistogramRecords(metricAttributesMap, 1, 0);
  });

  it('testOnEndMetricsGenerationWithoutMetricAttributes', () => {
    const spanAttributes: Attributes = { [SEMATTRS_HTTP_STATUS_CODE]: 500 };
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(spanAttributes);
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_NO_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    sinon.assert.notCalled(errorHistogramMockRecord);
    sinon.assert.notCalled(faultHistogramMockRecord);
    sinon.assert.notCalled(latencyHistogramMockRecord);
  });

  it('testsOnEndMetricsGenerationLocalRootServerSpan', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(
      spanAttributes,
      SpanKind.SERVER,
      INVALID_SPAN_CONTEXT,
      { code: SpanStatusCode.UNSET }
    );
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    verifyHistogramRecords(metricAttributesMap, 1, 0);
  });

  it('testsOnEndMetricsGenerationLocalRootConsumerSpan', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(
      spanAttributes,
      SpanKind.CONSUMER,
      INVALID_SPAN_CONTEXT,
      { code: SpanStatusCode.UNSET }
    );
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    verifyHistogramRecords(metricAttributesMap, 1, 1);
  });

  it('testsOnEndMetricsGenerationLocalRootClientSpan', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(
      spanAttributes,
      SpanKind.CLIENT,
      INVALID_SPAN_CONTEXT,
      { code: SpanStatusCode.UNSET }
    );
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    verifyHistogramRecords(metricAttributesMap, 1, 1);
  });

  it('testsOnEndMetricsGenerationLocalRootProducerSpan', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(
      spanAttributes,
      SpanKind.PRODUCER,
      INVALID_SPAN_CONTEXT,
      { code: SpanStatusCode.UNSET }
    );
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    verifyHistogramRecords(metricAttributesMap, 1, 1);
  });

  it('testsOnEndMetricsGenerationLocalRootInternalSpan', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(
      spanAttributes,
      SpanKind.INTERNAL,
      INVALID_SPAN_CONTEXT,
      { code: SpanStatusCode.UNSET }
    );
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    verifyHistogramRecords(metricAttributesMap, 1, 0);
  });

  it('testsOnEndMetricsGenerationLocalRootProducerSpanWithoutMetricAttributes', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(
      spanAttributes,
      SpanKind.PRODUCER,
      INVALID_SPAN_CONTEXT,
      { code: SpanStatusCode.UNSET }
    );
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_NO_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);
    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    sinon.assert.notCalled(errorHistogramMockRecord);
    sinon.assert.notCalled(faultHistogramMockRecord);
    sinon.assert.notCalled(latencyHistogramMockRecord);
  });

  it('testsOnEndMetricsGenerationClientSpan', () => {
    const mockSpanContext: SpanContext = createMockValidSpanContext();
    mockSpanContext.isRemote = false;
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(spanAttributes, SpanKind.CLIENT, mockSpanContext, {
      code: SpanStatusCode.UNSET,
    });
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    verifyHistogramRecords(metricAttributesMap, 0, 1);
  });

  it('testsOnEndMetricsGenerationProducerSpan', () => {
    const mockSpanContext: SpanContext = createMockValidSpanContext();
    mockSpanContext.isRemote = false;
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(spanAttributes, SpanKind.PRODUCER, mockSpanContext, {
      code: SpanStatusCode.UNSET,
    });
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    verifyHistogramRecords(metricAttributesMap, 0, 1);
  });

  it('testOnEndMetricsGenerationWithoutEndRequired', () => {
    const spanAttributes: Attributes = { [SEMATTRS_HTTP_STATUS_CODE]: 500 };
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(spanAttributes);
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    sinon.assert.calledOnceWithExactly(errorHistogramMockRecord, 0, metricAttributesMap[SERVICE_METRIC]);
    sinon.assert.calledOnceWithExactly(faultHistogramMockRecord, 1, metricAttributesMap[SERVICE_METRIC]);
    sinon.assert.calledOnceWithExactly(
      latencyHistogramMockRecord,
      TEST_LATENCY_MILLIS,
      metricAttributesMap[SERVICE_METRIC]
    );

    let wantedCalls: sinon.SinonSpyCall<
      [value: number, attributes?: Attributes | undefined, context?: Context | undefined],
      void
    >[];
    wantedCalls = errorHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(0, metricAttributesMap[DEPENDENCY_METRIC]));
    expect(wantedCalls.length).toEqual(0);
    wantedCalls = faultHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(0, metricAttributesMap[DEPENDENCY_METRIC]));
    expect(wantedCalls.length).toEqual(0);
    wantedCalls = latencyHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(TEST_LATENCY_MILLIS, metricAttributesMap[DEPENDENCY_METRIC]));
    expect(wantedCalls.length).toEqual(0);
  });

  it('testOnEndMetricsGenerationWithLatency', () => {
    const spanAttributes: Attributes = { [SEMATTRS_HTTP_STATUS_CODE]: 200 };
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(spanAttributes);
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    readableSpanMock.endTime[1] = 5_500_000;
    (readableSpanMock as any).duration = hrTimeDuration(readableSpanMock.startTime, readableSpanMock.endTime);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    sinon.assert.calledOnceWithExactly(errorHistogramMockRecord, 0, metricAttributesMap[SERVICE_METRIC]);
    sinon.assert.calledOnceWithExactly(faultHistogramMockRecord, 0, metricAttributesMap[SERVICE_METRIC]);
    sinon.assert.calledOnceWithExactly(latencyHistogramMockRecord, 5.5, metricAttributesMap[SERVICE_METRIC]);

    let wantedCalls: sinon.SinonSpyCall<
      [value: number, attributes?: Attributes | undefined, context?: Context | undefined],
      void
    >[];
    wantedCalls = errorHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(0, metricAttributesMap[DEPENDENCY_METRIC]));
    expect(wantedCalls.length).toEqual(0);
    wantedCalls = faultHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(0, metricAttributesMap[DEPENDENCY_METRIC]));
    expect(wantedCalls.length).toEqual(0);
    wantedCalls = latencyHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(5.5, metricAttributesMap[DEPENDENCY_METRIC]));
    expect(wantedCalls.length).toEqual(0);
  });

  it('testOnEndMetricsGenerationWithAwsStatusCodes', () => {
    // Invalid HTTP status codes
    validateMetricsGeneratedForAttributeStatusCode(undefined, ExpectedStatusMetric.NEITHER);

    // Valid HTTP status codes
    validateMetricsGeneratedForAttributeStatusCode(399, ExpectedStatusMetric.NEITHER);
    validateMetricsGeneratedForAttributeStatusCode(400, ExpectedStatusMetric.ERROR);
    validateMetricsGeneratedForAttributeStatusCode(499, ExpectedStatusMetric.ERROR);
    validateMetricsGeneratedForAttributeStatusCode(500, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForAttributeStatusCode(599, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForAttributeStatusCode(600, ExpectedStatusMetric.NEITHER);
  });

  it('testOnEndMetricsGenerationWithStatusCodes', () => {
    // Invalid HTTP status codes
    validateMetricsGeneratedForHttpStatusCode(undefined, ExpectedStatusMetric.NEITHER);

    // Valid HTTP status codes
    validateMetricsGeneratedForHttpStatusCode(200, ExpectedStatusMetric.NEITHER);
    validateMetricsGeneratedForHttpStatusCode(399, ExpectedStatusMetric.NEITHER);
    validateMetricsGeneratedForHttpStatusCode(400, ExpectedStatusMetric.ERROR);
    validateMetricsGeneratedForHttpStatusCode(499, ExpectedStatusMetric.ERROR);
    validateMetricsGeneratedForHttpStatusCode(500, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForHttpStatusCode(599, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForHttpStatusCode(600, ExpectedStatusMetric.NEITHER);
  });

  it('testOnEndMetricsGenerationWithStatusDataError', () => {
    // Empty Status and HTTP with Error Status
    validateMetricsGeneratedForStatusDataError(undefined, ExpectedStatusMetric.FAULT);

    // Valid HTTP with Error Status
    validateMetricsGeneratedForStatusDataError(200, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForStatusDataError(399, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForStatusDataError(400, ExpectedStatusMetric.ERROR);
    validateMetricsGeneratedForStatusDataError(499, ExpectedStatusMetric.ERROR);
    validateMetricsGeneratedForStatusDataError(500, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForStatusDataError(599, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForStatusDataError(600, ExpectedStatusMetric.FAULT);
  });

  it('testOnEndMetricsGenerationWithStatusDataOk', () => {
    // Empty Status and HTTP with Ok Status
    validateMetricsGeneratedForStatusDataOk(undefined, ExpectedStatusMetric.NEITHER);

    // Valid HTTP with Ok Status
    validateMetricsGeneratedForStatusDataOk(200, ExpectedStatusMetric.NEITHER);
    validateMetricsGeneratedForStatusDataOk(399, ExpectedStatusMetric.NEITHER);
    validateMetricsGeneratedForStatusDataOk(400, ExpectedStatusMetric.ERROR);
    validateMetricsGeneratedForStatusDataOk(499, ExpectedStatusMetric.ERROR);
    validateMetricsGeneratedForStatusDataOk(500, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForStatusDataOk(599, ExpectedStatusMetric.FAULT);
    validateMetricsGeneratedForStatusDataOk(600, ExpectedStatusMetric.NEITHER);
  });

  function buildSpanAttributes(containsAttribute: boolean): Attributes {
    if (containsAttribute) {
      return { 'original key': 'original value' };
    } else {
      return {};
    }
  }

  function buildMetricAttributes(containsAttribute: boolean, span: ReadableSpan): AttributeMap {
    const attributesMap: AttributeMap = {};
    if (containsAttribute) {
      let attributes: Attributes;
      if (AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(span)) {
        const attributes: Attributes = { 'new service key': 'new service value' };
        attributesMap[SERVICE_METRIC] = attributes;
      }
      if (AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(span)) {
        attributes = { 'new dependency key': 'new dependency value' };
        attributesMap[DEPENDENCY_METRIC] = attributes;
      }
    }
    return attributesMap;
  }

  function buildReadableSpanMock(
    spanAttributes: Attributes,
    spanKind: SpanKind = SpanKind.SERVER,
    parentSpanContext: SpanContext | undefined = undefined,
    statusData: SpanStatus = { code: SpanStatusCode.UNSET }
  ): ReadableSpan {
    const awsSdkInstrumentationLibrary: InstrumentationLibrary = {
      name: '@opentelemetry/instrumentation-aws-sdk',
    };

    const startTime: HrTime = [0, 0];
    const endTime: HrTime = [0, TEST_LATENCY_NANOS];
    const duration: HrTime = hrTimeDuration(startTime, endTime);

    // Configure spanData
    const mockSpanData: ReadableSpan = {
      name: 'spanName',
      // Configure Span Kind
      kind: spanKind,
      spanContext: () => {
        const spanContext: SpanContext = {
          traceId: '00000000000000000000000000000008',
          spanId: '0000000000000009',
          traceFlags: 0,
        };
        return spanContext;
      },
      startTime: startTime,
      // Configure latency
      endTime: endTime,
      // Configure Span Status
      status: statusData,
      // Configure attributes
      attributes: spanAttributes,
      links: [],
      events: [],
      duration: duration,
      ended: true,
      resource: new Resource({}),
      // Configure Instrumentation Library
      instrumentationLibrary: awsSdkInstrumentationLibrary,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };

    if (parentSpanContext === undefined) {
      parentSpanContext = INVALID_SPAN_CONTEXT;
    } else {
      (mockSpanData as any).parentSpanId = parentSpanContext.spanId;
    }
    const isParentSpanContextValid: boolean = parentSpanContext !== undefined && isSpanContextValid(parentSpanContext);
    const isParentSpanRemote: boolean = parentSpanContext !== undefined && parentSpanContext.isRemote === true;
    const isLocalRoot: boolean =
      mockSpanData.parentSpanId === undefined || !isParentSpanContextValid || isParentSpanRemote;
    mockSpanData.attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = isLocalRoot;

    return mockSpanData;
  }

  function configureMocksForOnEnd(readableSpanMock: ReadableSpan, metricAttributesMap: AttributeMap): void {
    // Configure generated attributes
    generatorMock.generateMetricAttributeMapFromSpan = (span: ReadableSpan, resource: Resource) => {
      if (readableSpanMock === span && testResource === resource) {
        return metricAttributesMap;
      }
      return {};
    };
  }

  function validateMetricsGeneratedForHttpStatusCode(
    httpStatusCode: number | undefined,
    expectedStatusMetric: ExpectedStatusMetric
  ): void {
    const spanAttributes: Attributes = { [SEMATTRS_HTTP_STATUS_CODE]: httpStatusCode };
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(spanAttributes, SpanKind.PRODUCER, undefined, {
      code: SpanStatusCode.UNSET,
    });
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    validateMetrics(metricAttributesMap, expectedStatusMetric);
  }

  function validateMetricsGeneratedForAttributeStatusCode(
    awsStatusCode: number | undefined,
    expectedStatusMetric: ExpectedStatusMetric
  ): void {
    // Testing Dependency Metric
    const attributes: Attributes = { 'new key': 'new value' };
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(attributes, SpanKind.PRODUCER, undefined, {
      code: SpanStatusCode.UNSET,
    });
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    if (awsStatusCode !== undefined) {
      metricAttributesMap[SERVICE_METRIC] = {
        'new service key': 'new service value',
        [SEMATTRS_HTTP_STATUS_CODE]: awsStatusCode,
      };
      metricAttributesMap[DEPENDENCY_METRIC] = {
        'new dependency key': 'new dependency value',
        [SEMATTRS_HTTP_STATUS_CODE]: awsStatusCode,
      };
    }
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);
    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    validateMetrics(metricAttributesMap, expectedStatusMetric);
  }

  function validateMetricsGeneratedForStatusDataError(
    httpStatusCode: number | undefined,
    expectedStatusMetric: ExpectedStatusMetric
  ): void {
    const spanAttributes: Attributes = { [SEMATTRS_HTTP_STATUS_CODE]: httpStatusCode };
    const readableSpanMock: ReadableSpan = buildReadableSpanMock(spanAttributes, SpanKind.PRODUCER, undefined, {
      code: SpanStatusCode.ERROR,
    });
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    validateMetrics(metricAttributesMap, expectedStatusMetric);
  }

  function validateMetricsGeneratedForStatusDataOk(
    httpStatusCode: number | undefined,
    expectedStatusMetric: ExpectedStatusMetric
  ): void {
    const spanAttributes: Attributes = { [SEMATTRS_HTTP_STATUS_CODE]: httpStatusCode };

    const readableSpanMock: ReadableSpan = buildReadableSpanMock(spanAttributes, SpanKind.PRODUCER, undefined, {
      code: SpanStatusCode.OK,
    });
    const metricAttributesMap: AttributeMap = buildMetricAttributes(CONTAINS_ATTRIBUTES, readableSpanMock);
    configureMocksForOnEnd(readableSpanMock, metricAttributesMap);

    awsSpanMetricsProcessor.onEnd(readableSpanMock);
    validateMetrics(metricAttributesMap, expectedStatusMetric);
  }

  function validateMetrics(metricAttributesMap: AttributeMap, expectedStatusMetric: ExpectedStatusMetric): void {
    const serviceAttributes: Attributes = metricAttributesMap[SERVICE_METRIC];
    const dependencyAttributes: Attributes = metricAttributesMap[DEPENDENCY_METRIC];
    let wantedCalls: sinon.SinonSpyCall<
      [value: number, attributes?: Attributes | undefined, context?: Context | undefined],
      void
    >[];
    switch (expectedStatusMetric) {
      case ExpectedStatusMetric.ERROR:
        wantedCalls = errorHistogramMockRecord.getCalls().filter(call => call.calledWithExactly(1, serviceAttributes));
        expect(wantedCalls.length).toEqual(1);
        wantedCalls = faultHistogramMockRecord.getCalls().filter(call => call.calledWithExactly(0, serviceAttributes));
        expect(wantedCalls.length).toEqual(1);
        wantedCalls = errorHistogramMockRecord
          .getCalls()
          .filter(call => call.calledWithExactly(1, dependencyAttributes));
        expect(wantedCalls.length).toEqual(1);
        wantedCalls = faultHistogramMockRecord
          .getCalls()
          .filter(call => call.calledWithExactly(0, dependencyAttributes));
        expect(wantedCalls.length).toEqual(1);
        break;
      case ExpectedStatusMetric.FAULT:
        wantedCalls = errorHistogramMockRecord.getCalls().filter(call => call.calledWithExactly(0, serviceAttributes));
        expect(wantedCalls.length).toEqual(1);
        wantedCalls = faultHistogramMockRecord.getCalls().filter(call => call.calledWithExactly(1, serviceAttributes));
        expect(wantedCalls.length).toEqual(1);
        wantedCalls = errorHistogramMockRecord
          .getCalls()
          .filter(call => call.calledWithExactly(0, dependencyAttributes));
        expect(wantedCalls.length).toEqual(1);
        wantedCalls = faultHistogramMockRecord
          .getCalls()
          .filter(call => call.calledWithExactly(1, dependencyAttributes));
        expect(wantedCalls.length).toEqual(1);
        break;
      case ExpectedStatusMetric.NEITHER:
        wantedCalls = errorHistogramMockRecord.getCalls().filter(call => call.calledWithExactly(0, serviceAttributes));
        expect(wantedCalls.length).toEqual(1);
        wantedCalls = faultHistogramMockRecord.getCalls().filter(call => call.calledWithExactly(0, serviceAttributes));
        expect(wantedCalls.length).toEqual(1);
        wantedCalls = errorHistogramMockRecord
          .getCalls()
          .filter(call => call.calledWithExactly(0, dependencyAttributes));
        expect(wantedCalls.length).toEqual(1);
        wantedCalls = faultHistogramMockRecord
          .getCalls()
          .filter(call => call.calledWithExactly(0, dependencyAttributes));
        expect(wantedCalls.length).toEqual(1);
        break;
    }

    wantedCalls = latencyHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(TEST_LATENCY_MILLIS, serviceAttributes));
    expect(wantedCalls.length).toEqual(1);

    wantedCalls = latencyHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(TEST_LATENCY_MILLIS, dependencyAttributes));
    expect(wantedCalls.length).toEqual(1);

    // Clear invocations so this method can be called multiple times in one test.
    errorHistogramMockRecord.reset();
    faultHistogramMockRecord.reset();
    latencyHistogramMockRecord.reset();
  }

  function verifyHistogramRecords(
    metricAttributesMap: AttributeMap,
    wantedServiceMetricInvocation: number,
    wantedDependencyMetricInvocation: number
  ): void {
    let wantedCalls: sinon.SinonSpyCall<
      [value: number, attributes?: Attributes | undefined, context?: Context | undefined],
      void
    >[];
    wantedCalls = errorHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(0, metricAttributesMap[SERVICE_METRIC]));
    expect(wantedCalls.length).toEqual(wantedServiceMetricInvocation);

    wantedCalls = faultHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(0, metricAttributesMap[SERVICE_METRIC]));
    expect(wantedCalls.length).toEqual(wantedServiceMetricInvocation);

    wantedCalls = latencyHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(TEST_LATENCY_MILLIS, metricAttributesMap[SERVICE_METRIC]));
    expect(wantedCalls.length).toEqual(wantedServiceMetricInvocation);

    wantedCalls = errorHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(0, metricAttributesMap[DEPENDENCY_METRIC]));
    expect(wantedCalls.length).toEqual(wantedDependencyMetricInvocation);

    wantedCalls = faultHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(0, metricAttributesMap[DEPENDENCY_METRIC]));
    expect(wantedCalls.length).toEqual(wantedDependencyMetricInvocation);

    wantedCalls = latencyHistogramMockRecord
      .getCalls()
      .filter(call => call.calledWithExactly(TEST_LATENCY_MILLIS, metricAttributesMap[DEPENDENCY_METRIC]));
    expect(wantedCalls.length).toEqual(wantedDependencyMetricInvocation);
  }

  function createMockValidSpanContext(): SpanContext {
    return {
      traceId: '00000000000000000000000000000004',
      spanId: '0000000000000005',
      traceFlags: 0,
    };
  }
});
