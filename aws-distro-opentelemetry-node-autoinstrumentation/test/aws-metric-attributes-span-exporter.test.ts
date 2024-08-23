// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue, Attributes, Link, SpanContext, SpanKind, SpanStatus } from '@opentelemetry/api';
import { InstrumentationLibrary } from '@opentelemetry/core';
import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { MESSAGINGOPERATIONVALUES_PROCESS, SEMATTRS_MESSAGING_OPERATION } from '@opentelemetry/semantic-conventions';
import expect from 'expect';
import * as sinon from 'sinon';
import { AWS_ATTRIBUTE_KEYS } from '../src/aws-attribute-keys';
import { AwsMetricAttributeGenerator } from '../src/aws-metric-attribute-generator';
import { AwsMetricAttributesSpanExporter } from '../src/aws-metric-attributes-span-exporter';
import { AwsSpanProcessingUtil } from '../src/aws-span-processing-util';
import {
  AttributeMap,
  DEPENDENCY_METRIC,
  MetricAttributeGenerator,
  SERVICE_METRIC,
} from '../src/metric-attribute-generator';

describe('AwsMetricAttributesSpanExporterTest', () => {
  // Test constants
  const CONTAINS_ATTRIBUTES = true;
  const CONTAINS_NO_ATTRIBUTES = false;

  // Tests can safely rely on an empty resource.
  const testResource: Resource = Resource.empty();

  // Mocks required for tests.
  let generatorMock: MetricAttributeGenerator;
  let delegateMock: SpanExporter;

  let delegateMockForceFlush: sinon.SinonStub<any[], any>;
  let delegateMockShutdown: sinon.SinonStub<[], Promise<void>>;
  let delegateMockExport: sinon.SinonStub<any[], any>;

  let awsMetricAttributesSpanExporter: AwsMetricAttributesSpanExporter;

  beforeEach(() => {
    generatorMock = new AwsMetricAttributeGenerator();
    delegateMock = new OTLPHttpTraceExporter();

    delegateMockForceFlush = sinon.stub(delegateMock, 'forceFlush');
    delegateMockShutdown = sinon.stub(delegateMock, 'shutdown');
    delegateMockExport = sinon.stub(delegateMock, 'export');

    awsMetricAttributesSpanExporter = AwsMetricAttributesSpanExporter.create(delegateMock, generatorMock, testResource);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('testPassthroughDelegations', () => {
    awsMetricAttributesSpanExporter.forceFlush();
    awsMetricAttributesSpanExporter.shutdown();
    sinon.assert.calledOnce(delegateMockForceFlush);
    sinon.assert.calledOnce(delegateMockShutdown);
  });

  it('testExportDelegationWithoutAttributeOrModification', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const spanDataMock: ReadableSpan = buildSpanDataMock(spanAttributes);
    const metricAttributes: Attributes = buildMetricAttributes(CONTAINS_NO_ATTRIBUTES);
    configureMocksForExport(spanDataMock, metricAttributes);

    awsMetricAttributesSpanExporter.export([spanDataMock], () => {});
    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(1);

    const exportedSpan: ReadableSpan = exportedSpans[0];
    expect(exportedSpan).toEqual(spanDataMock);
  });

  it('testExportDelegationWithAttributeButWithoutModification', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_ATTRIBUTES);
    const spanDataMock: ReadableSpan = buildSpanDataMock(spanAttributes);
    const metricAttributes: Attributes = buildMetricAttributes(CONTAINS_NO_ATTRIBUTES);
    configureMocksForExport(spanDataMock, metricAttributes);

    awsMetricAttributesSpanExporter.export([spanDataMock], () => {});

    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(1);

    const exportedSpan: ReadableSpan = exportedSpans[0];
    expect(exportedSpan).toEqual(spanDataMock);
  });

  it('testExportDelegationWithoutAttributeButWithModification', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const spanDataMock: ReadableSpan = buildSpanDataMock(spanAttributes);
    const metricAttributes: Attributes = buildMetricAttributes(CONTAINS_ATTRIBUTES);
    configureMocksForExport(spanDataMock, metricAttributes);

    awsMetricAttributesSpanExporter.export([spanDataMock], () => {});
    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(1);

    const exportedSpan: ReadableSpan = exportedSpans[0];
    const exportedAttributes: Attributes = exportedSpan.attributes;
    expect(Object.keys(exportedAttributes).length).toEqual(Object.keys(metricAttributes).length);
    for (const k in metricAttributes) {
      expect(exportedAttributes[k]).toEqual(metricAttributes[k]);
    }
  });

  it('testExportDelegationWithAttributeAndModification', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_ATTRIBUTES);
    const spanDataMock: ReadableSpan = buildSpanDataMock(spanAttributes);
    const metricAttributes: Attributes = buildMetricAttributes(CONTAINS_ATTRIBUTES);
    configureMocksForExport(spanDataMock, metricAttributes);

    awsMetricAttributesSpanExporter.export([spanDataMock], () => {});
    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(1);

    const exportedSpan: ReadableSpan = exportedSpans[0];
    const expectedAttributeCount: number = Object.keys(metricAttributes).length + Object.keys(spanAttributes).length;
    const exportedAttributes: Attributes = exportedSpan.attributes;
    expect(Object.keys(exportedAttributes).length).toEqual(expectedAttributeCount);
    for (const k in spanAttributes) {
      expect(exportedAttributes[k]).toEqual(spanAttributes[k]);
    }
    for (const k in metricAttributes) {
      expect(exportedAttributes[k]).toEqual(metricAttributes[k]);
    }
  });

  it('testExportDelegationWithMultipleSpans', () => {
    const spanAttributes1: Attributes = buildSpanAttributes(CONTAINS_NO_ATTRIBUTES);
    const spanDataMock1: ReadableSpan = buildSpanDataMock(spanAttributes1);
    const metricAttributes1: Attributes = buildMetricAttributes(CONTAINS_NO_ATTRIBUTES);
    configureMocksForExport(spanDataMock1, metricAttributes1);

    const spanAttributes2: Attributes = buildSpanAttributes(CONTAINS_ATTRIBUTES);
    const spanDataMock2: ReadableSpan = buildSpanDataMock(spanAttributes2);
    const metricAttributes2: Attributes = buildMetricAttributes(CONTAINS_ATTRIBUTES);
    configureMocksForExport(spanDataMock2, metricAttributes2);

    const spanAttributes3: Attributes = buildSpanAttributes(CONTAINS_ATTRIBUTES);
    const spanDataMock3: ReadableSpan = buildSpanDataMock({ ...spanAttributes3 });
    const metricAttributes3: Attributes = buildMetricAttributes(CONTAINS_NO_ATTRIBUTES);
    configureMocksForExport(spanDataMock3, metricAttributes3);

    configureMocksForExportWithMultipleSideEffect(
      [spanDataMock1, spanDataMock2, spanDataMock3],
      [metricAttributes1, metricAttributes2, metricAttributes3]
    );

    awsMetricAttributesSpanExporter.export([spanDataMock1, spanDataMock2, spanDataMock3], () => {});

    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(3);

    const exportedSpan1: ReadableSpan = exportedSpans[0];
    const exportedSpan2: ReadableSpan = exportedSpans[1];
    const exportedSpan3: ReadableSpan = exportedSpans[2];

    expect(exportedSpan1).toEqual(spanDataMock1);
    expect(exportedSpan3).toEqual(spanDataMock3);

    const expectedAttributeCount: number = Object.keys(metricAttributes2).length + Object.keys(spanAttributes2).length;
    const exportedAttributes: Attributes = exportedSpan2.attributes;
    expect(Object.keys(exportedAttributes).length).toEqual(expectedAttributeCount);
    for (const k in spanAttributes2) {
      expect(exportedAttributes[k]).toEqual(spanAttributes2[k]);
    }
    for (const k in metricAttributes2) {
      expect(exportedAttributes[k]).toEqual(metricAttributes2[k]);
    }
  });

  it('testOverridenAttributes', () => {
    const spanAttributes: Attributes = {
      key1: 'old value1',
      key2: 'old value2',
    };
    const spanDataMock: ReadableSpan = buildSpanDataMock(spanAttributes);
    const metricAttributes: Attributes = {
      key1: 'new value1',
      key3: 'new value3',
    };
    configureMocksForExport(spanDataMock, metricAttributes);

    awsMetricAttributesSpanExporter.export([spanDataMock], () => {});
    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(1);

    const exportedSpan: ReadableSpan = exportedSpans[0];
    expect(Object.keys(exportedSpan.attributes).length).toEqual(3);
    const exportedAttributes: Attributes = exportedSpan.attributes;
    expect(Object.keys(exportedAttributes).length).toEqual(3);
    expect(exportedAttributes['key1']).toEqual('new value1');
    expect(exportedAttributes['key2']).toEqual('old value2');
    expect(exportedAttributes['key3']).toEqual('new value3');
  });

  it('testExportDelegatingSpanDataBehaviour', () => {
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_ATTRIBUTES);
    const spanDataMock: ReadableSpan = buildSpanDataMock(spanAttributes);
    const metricAttributes: Attributes = buildMetricAttributes(CONTAINS_ATTRIBUTES);
    configureMocksForExport(spanDataMock, metricAttributes);

    awsMetricAttributesSpanExporter.export([spanDataMock], () => {});

    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(1);

    const exportedSpan: ReadableSpan = exportedSpans[0];

    const spanContextMock: SpanContext = createMockSpanContext();
    (spanDataMock as any).spanContext = spanContextMock;
    expect(exportedSpan.spanContext).toEqual(spanContextMock);

    (spanDataMock as any).parentSpanId = '0000000000000003';
    expect(exportedSpan.parentSpanId).toEqual(spanDataMock.parentSpanId);

    (spanDataMock as any).resource = testResource;
    expect(exportedSpan.resource).toEqual(testResource);

    const testInstrumentationLibrary: InstrumentationLibrary = { name: 'mockedLibrary' };
    (spanDataMock as any).instrumentationLibrary = testInstrumentationLibrary;
    expect(exportedSpan.instrumentationLibrary).toEqual(testInstrumentationLibrary);

    const testName = 'name';
    (spanDataMock as any).name = testName;
    expect(exportedSpan.name).toEqual(testName);

    const kindMock: SpanKind = SpanKind.SERVER;
    (spanDataMock as any).kind = kindMock;
    expect(exportedSpan.kind).toEqual(kindMock);

    const testStartEpochNanos = 1;
    spanDataMock.startTime[1] = testStartEpochNanos;
    expect(exportedSpan.startTime[1]).toEqual(testStartEpochNanos);

    const eventsMock: TimedEvent[] = [{ time: [0, 1], name: 'event0' }];
    (spanDataMock as any).events = eventsMock;
    expect(exportedSpan.events).toEqual(eventsMock);

    const linksMock: Link[] = [{ context: createMockSpanContext() }];
    (spanDataMock as any).links = linksMock;
    expect(exportedSpan.links).toEqual(linksMock);

    const statusMock: SpanStatus = { code: 0 };
    (spanDataMock as any).status = statusMock;
    expect(exportedSpan.status).toEqual(statusMock);

    const testEndEpochNanosMock = 2;
    spanDataMock.endTime[1] = testEndEpochNanosMock;
    expect(exportedSpan.endTime[1]).toEqual(testEndEpochNanosMock);

    (spanDataMock as any).ended = true;
    expect(exportedSpan.ended).toEqual(true);

    const testTotalRecordedEventsMock = 3;
    (spanDataMock as any).events = [
      { time: [0, 1], name: 'event0' },
      { time: [0, 2], name: 'event1' },
      { time: [0, 3], name: 'event2' },
    ];
    expect(exportedSpan.events.length).toEqual(testTotalRecordedEventsMock);

    const testTotalRecordedLinksMock = 4;
    (spanDataMock as any).links = [
      createMockSpanContext(),
      createMockSpanContext(),
      createMockSpanContext(),
      createMockSpanContext(),
    ];
    expect(exportedSpan.links.length).toEqual(testTotalRecordedLinksMock);
  });

  it('testExportDelegationWithTwoMetrics', () => {
    // Original Span Attribute
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_ATTRIBUTES);

    // Create new span data mock
    const spanDataMock: ReadableSpan = createReadableSpanMock();
    (spanDataMock as any).attributes = { ...spanAttributes };
    (spanDataMock as any).kind = SpanKind.PRODUCER;
    (spanDataMock as any).parentSpanId = undefined;

    // Create mock for the generateMetricAttributeMapFromSpan. Returns both dependency and service
    // metric
    const attributeMap: AttributeMap = {};
    const serviceMtricAttributes: Attributes = { 'new service key': 'new service value' };
    attributeMap[SERVICE_METRIC] = serviceMtricAttributes;

    const dependencyMetricAttributes: Attributes = {
      'new dependency key': 'new dependency value',
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.PRODUCER],
    };
    attributeMap[DEPENDENCY_METRIC] = dependencyMetricAttributes;

    generatorMock.generateMetricAttributeMapFromSpan = (span: ReadableSpan, resource: Resource) => {
      if (spanDataMock === span && testResource === resource) {
        return attributeMap;
      }
      return {};
    };

    awsMetricAttributesSpanExporter.export([spanDataMock], () => {});
    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(1);

    // Retrieve the returned span
    const exportedSpan: ReadableSpan = exportedSpans[0];

    // Check the number of attributes
    const expectedAttributeCount: number =
      Object.keys(dependencyMetricAttributes).length + Object.keys(spanAttributes).length;
    const exportedAttributes: Attributes = exportedSpan.attributes;
    expect(Object.keys(exportedAttributes).length).toEqual(expectedAttributeCount);

    // Check that all expected attributes are present
    for (const k in spanAttributes) {
      const v: AttributeValue | undefined = spanAttributes[k];
      expect(exportedAttributes[k]).toEqual(v);
    }

    for (const k in dependencyMetricAttributes) {
      const v: AttributeValue | undefined = dependencyMetricAttributes[k];
      if (k === AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND) {
        expect(exportedAttributes[k]).not.toEqual(v);
      } else {
        expect(exportedAttributes[k]).toEqual(v);
      }
    }

    expect(exportedAttributes[AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]).toEqual(AwsSpanProcessingUtil.LOCAL_ROOT);
  });

  it('testConsumerProcessSpanHasEmptyAttribute', () => {
    const attributesMock: Attributes = {};
    const spanDataMock: ReadableSpan = createReadableSpanMock();
    const parentSpanContextMock: SpanContext = createMockSpanContext();

    attributesMock[AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND] = SpanKind[SpanKind.CONSUMER];
    attributesMock[SEMATTRS_MESSAGING_OPERATION] = MESSAGINGOPERATIONVALUES_PROCESS;
    // set AWS_IS_LOCAL_ROOT as false because parentSpanContext is valid and not remote in this test
    attributesMock[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = false;
    (spanDataMock as any).kind = SpanKind.CONSUMER;
    (spanDataMock as any).attributes = attributesMock;
    parentSpanContextMock.isRemote = false;

    // The dependencyAttributesMock will only be used if
    // AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(span) is true.
    // It shouldn't have any interaction since the spanData is a consumer process with parent span
    // of consumer
    const attributeMap: AttributeMap = {};
    const dependencyAttributesMock: Attributes = {};
    attributeMap[DEPENDENCY_METRIC] = dependencyAttributesMock;
    // Configure generated attributes
    generatorMock.generateMetricAttributeMapFromSpan = (span: ReadableSpan, resource: Resource) => {
      if (spanDataMock === span && testResource === resource) {
        return attributeMap;
      }
      return {};
    };

    awsMetricAttributesSpanExporter.export([spanDataMock], () => {});

    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(1);

    expect(dependencyAttributesMock).toEqual({});

    const exportedSpan: ReadableSpan = exportedSpans[0];
    expect(exportedSpan).toEqual(spanDataMock);
  });

  it('testExportDelegationWithDependencyMetrics', () => {
    // Original Span Attribute
    const spanAttributes: Attributes = buildSpanAttributes(CONTAINS_ATTRIBUTES);

    // Create new span data mock
    const spanDataMock: ReadableSpan = createReadableSpanMock();
    // set AWS_IS_LOCAL_ROOT as false because parentSpanContext is valid and not remote in this test
    spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = false;

    (spanDataMock as any).attributes = spanAttributes;
    (spanDataMock as any).kind = SpanKind.PRODUCER;

    // Create mock for the generateMetricAttributeMapFromSpan. Returns dependency metric
    const metricAttributes: Attributes = { 'new service key': 'new dependency value' };
    const attributeMap: AttributeMap = {
      [DEPENDENCY_METRIC]: metricAttributes,
    };

    generatorMock.generateMetricAttributeMapFromSpan = (span: ReadableSpan, resource: Resource) => {
      if (spanDataMock === span && testResource === resource) {
        return attributeMap;
      }
      return {};
    };

    awsMetricAttributesSpanExporter.export([spanDataMock], () => {});

    sinon.assert.calledOnce(delegateMockExport);
    const exportedSpans: ReadableSpan[] = delegateMockExport.getCall(0).args[0];
    expect(exportedSpans.length).toEqual(1);

    // Retrieve the returned span
    const exportedSpan: ReadableSpan = exportedSpans[0];

    // Check the number of attributes
    const expectedAttributeCount: number = Object.keys(metricAttributes).length + Object.keys(spanAttributes).length;
    const exportedAttributes: Attributes = exportedSpan.attributes;
    expect(Object.keys(exportedAttributes).length).toEqual(expectedAttributeCount);

    // Check that all expected attributes are present
    for (const k in spanAttributes) {
      expect(exportedAttributes[k]).toEqual(spanAttributes[k]);
    }
    for (const k in metricAttributes) {
      expect(exportedAttributes[k]).toEqual(metricAttributes[k]);
    }
  });

  function buildSpanAttributes(containsAttribute: boolean): Attributes {
    if (containsAttribute) {
      return { 'original key': 'original value' };
    } else {
      return {};
    }
  }

  function buildMetricAttributes(containsAttribute: boolean): Attributes {
    if (containsAttribute) {
      return { 'new key': 'new value' };
    } else {
      return {};
    }
  }

  function buildSpanDataMock(spanAttributes: Attributes): ReadableSpan {
    // Configure spanData
    const mockSpanData: ReadableSpan = {
      name: 'spanName',
      kind: SpanKind.SERVER,
      spanContext: () => {
        const spanContext: SpanContext = {
          traceId: '00000000000000000000000000000008',
          spanId: '0000000000000009',
          traceFlags: 0,
        };
        return spanContext;
      },
      startTime: [0, 0],
      endTime: [0, 1],
      status: { code: 0 },
      attributes: {},
      links: [],
      events: [],
      duration: [0, 1],
      ended: true,
      resource: new Resource({}),
      instrumentationLibrary: { name: 'mockedLibrary' },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    (mockSpanData as any).attributes = spanAttributes;
    (mockSpanData as any).kind = SpanKind.SERVER;
    return mockSpanData;
  }

  function configureMocksForExport(spanDataMock: ReadableSpan, metricAttributes: Attributes): void {
    const attributeMap: AttributeMap = {};
    if (AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)) {
      attributeMap[SERVICE_METRIC] = metricAttributes;
    }

    if (AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)) {
      attributeMap[DEPENDENCY_METRIC] = metricAttributes;
    }

    // Configure generated attributes
    generatorMock.generateMetricAttributeMapFromSpan = (span: ReadableSpan, resource: Resource) => {
      if (span === spanDataMock && resource === testResource) {
        return attributeMap;
      }
      return {};
    };
  }

  function configureMocksForExportWithMultipleSideEffect(
    spanDataMocks: ReadableSpan[],
    metricAttributesList: Attributes[]
  ): void {
    const attributeMapList: AttributeMap[] = [];
    spanDataMocks.forEach((spanDataMock, i) => {
      const attributeMap: AttributeMap = {};
      if (AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(spanDataMock)) {
        attributeMap[SERVICE_METRIC] = { ...metricAttributesList[i] };
      }

      if (AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(spanDataMock)) {
        attributeMap[DEPENDENCY_METRIC] = { ...metricAttributesList[i] };
      }
      attributeMapList.push(attributeMap);
    });
    function sideEffect(span: ReadableSpan, resource: Resource) {
      const index: number = spanDataMocks.indexOf(span);
      if (index > -1 && resource === testResource) {
        return attributeMapList[index];
      }
      return {};
    }
    generatorMock.generateMetricAttributeMapFromSpan = sideEffect;
  }

  function createReadableSpanMock(): ReadableSpan {
    const mockSpanData: ReadableSpan = {
      name: 'spanName',
      kind: SpanKind.SERVER,
      spanContext: () => {
        const spanContext: SpanContext = {
          traceId: '00000000000000000000000000000008',
          spanId: '0000000000000009',
          traceFlags: 0,
        };
        return spanContext;
      },
      startTime: [0, 0],
      endTime: [0, 1],
      status: { code: 0 },
      attributes: {},
      links: [],
      events: [],
      duration: [0, 1],
      ended: true,
      resource: new Resource({}),
      instrumentationLibrary: { name: 'mockedLibrary' },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    return mockSpanData;
  }

  function createMockSpanContext(): SpanContext {
    return {
      traceId: '00000000000000000000000000000008',
      spanId: '0000000000000009',
      traceFlags: 0,
    };
  }
});
