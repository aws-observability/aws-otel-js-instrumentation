// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue, Attributes, SpanContext, SpanKind } from '@opentelemetry/api';
import { InstrumentationLibrary } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  MESSAGINGOPERATIONVALUES_PROCESS,
  SEMATTRS_DB_CONNECTION_STRING,
  SEMATTRS_DB_NAME,
  SEMATTRS_DB_OPERATION,
  SEMATTRS_DB_STATEMENT,
  SEMATTRS_DB_SYSTEM,
  SEMATTRS_DB_USER,
  SEMATTRS_FAAS_INVOKED_NAME,
  SEMATTRS_FAAS_INVOKED_PROVIDER,
  SEMATTRS_FAAS_TRIGGER,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_TARGET,
  SEMATTRS_HTTP_URL,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
  SEMATTRS_NET_PEER_NAME,
  SEMATTRS_NET_PEER_PORT,
  SEMATTRS_PEER_SERVICE,
  SEMATTRS_RPC_METHOD,
  SEMATTRS_RPC_SERVICE,
  SEMATTRS_RPC_SYSTEM,
  SEMRESATTRS_SERVICE_NAME,
} from '@opentelemetry/semantic-conventions';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../src/aws-attribute-keys';
import { AwsMetricAttributeGenerator } from '../src/aws-metric-attribute-generator';
import { AttributeMap, DEPENDENCY_METRIC, SERVICE_METRIC } from '../src/metric-attribute-generator';
import { AwsSpanProcessingUtil } from '../src/aws-span-processing-util';

// Does not exist in @opentelemetry/semantic-conventions
const _SERVER_SOCKET_ADDRESS: string = 'server.socket.address';
const _SERVER_SOCKET_PORT: string = 'server.socket.port';
const _NET_SOCK_PEER_ADDR: string = 'net.sock.peer.addr';
const _NET_SOCK_PEER_PORT: string = 'net.sock.peer.port';
// Alternatively, `import { SemanticAttributes } from '@opentelemetry/instrumentation-undici/build/src/enums/SemanticAttributes';`
//   SemanticAttributes._SERVER_ADDRESS
//   SemanticAttributes._SERVER_PORT
const _SERVER_ADDRESS: string = 'server.address';
const _SERVER_PORT: string = 'server.port';
// Alternatively, `import { AttributeNames } from '@opentelemetry/instrumentation-graphql/build/src/enums/AttributeNames';`
//   AttributeNames.OPERATION_TYPE
const _GRAPHQL_OPERATION_TYPE: string = 'graphql.operation.type';

// String constants that are used many times in these tests.
const AWS_LOCAL_OPERATION_VALUE: string = 'AWS local operation';
const AWS_REMOTE_SERVICE_VALUE: string = 'AWS remote service';
const AWS_REMOTE_OPERATION_VALUE: string = 'AWS remote operation';
const SERVICE_NAME_VALUE: string = 'Service name';
const SPAN_NAME_VALUE: string = 'Span name';
const UNKNOWN_SERVICE: string = 'UnknownService';
const UNKNOWN_OPERATION: string = 'UnknownOperation';
const UNKNOWN_REMOTE_SERVICE: string = 'UnknownRemoteService';
const UNKNOWN_REMOTE_OPERATION: string = 'UnknownRemoteOperation';
const INTERNAL_OPERATION: string = 'InternalOperation';
const LOCAL_ROOT: string = 'LOCAL_ROOT';

const GENERATOR: AwsMetricAttributeGenerator = new AwsMetricAttributeGenerator();

let attributesMock: Attributes;
let spanDataMock: ReadableSpan;
let instrumentationLibraryMock: InstrumentationLibrary;
let resource: Resource;

/** Unit tests for {@link AwsMetricAttributeGenerator}. */
describe('AwsMetricAttributeGeneratorTest', () => {
  // setUpMocks
  beforeEach(() => {
    attributesMock = {};
    instrumentationLibraryMock = {
      name: 'Scope name',
    };
    spanDataMock = {
      name: 'spanDataMockName',
      kind: SpanKind.SERVER,
      spanContext: () => {
        const spanContext: SpanContext = {
          traceId: '00000000000000000000000000000008',
          spanId: '0000000000000009',
          traceFlags: 0,
        };
        return spanContext;
      },
      parentSpanId: '0000000000000007',
      startTime: [0, 0],
      endTime: [0, 1],
      status: { code: 0 },
      attributes: attributesMock,
      links: [],
      events: [],
      duration: [0, 1],
      ended: true,
      resource: Resource.default(),
      instrumentationLibrary: instrumentationLibraryMock,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as false because parentSpanContext is valid and not remote in this test
    attributesMock[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = false;

    // OTel strongly recommends to start out with the default instead of Resource.empty()
    // In OTel JS, default Resource's default Service Name is `unknown_service:${process.argv0}`
    // - https://github.com/open-telemetry/opentelemetry-js/blob/b2778e1b2ff7b038cebf371f1eb9f808fd98107f/packages/opentelemetry-resources/src/platform/node/default-service-name.ts#L16
    resource = Resource.default();
  });

  it('testSpanAttributesForEmptyResource', () => {
    resource = Resource.empty();
    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: UNKNOWN_SERVICE,
      // This is tested to be UNKNOWN_OPERATION in Java/Python
      // This is because in other langauges, span name could be null, but
      // this is not possible in OTel JS.
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: 'spanDataMockName',
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
  });

  it('testConsumerSpanWithoutAttributes', () => {
    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.CONSUMER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: UNKNOWN_SERVICE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: UNKNOWN_OPERATION,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]: UNKNOWN_REMOTE_SERVICE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]: UNKNOWN_REMOTE_OPERATION,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.CONSUMER);
  });

  it('testServerSpanWithoutAttributes', () => {
    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: UNKNOWN_SERVICE,
      // This is tested to be UNKNOWN_OPERATION in Java/Python
      // This is because in other langauges, span name could be null, but
      // this is not possible in OTel JS.
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: 'spanDataMockName',
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
  });

  it('testProducerSpanWithoutAttributes', () => {
    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.PRODUCER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: UNKNOWN_SERVICE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: UNKNOWN_OPERATION,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]: UNKNOWN_REMOTE_SERVICE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]: UNKNOWN_REMOTE_OPERATION,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.PRODUCER);
  });

  it('testClientSpanWithoutAttributes', () => {
    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.CLIENT],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: UNKNOWN_SERVICE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: UNKNOWN_OPERATION,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]: UNKNOWN_REMOTE_SERVICE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]: UNKNOWN_REMOTE_OPERATION,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.CLIENT);
  });

  it('testInternalSpan', () => {
    // Spans with internal span kind should not produce any attributes.
    validateAttributesProducedForNonLocalRootSpanOfKind({}, SpanKind.INTERNAL);
  });

  it('testLocalRootServerSpan', () => {
    updateResourceWithServiceName();
    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as true because parentSpanContext is not valid in this test
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT, true);
    (spanDataMock as any).name = SPAN_NAME_VALUE;

    const expectedAttributesMap: AttributeMap = {};
    expectedAttributesMap[SERVICE_METRIC] = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: LOCAL_ROOT,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: SPAN_NAME_VALUE,
    };

    (spanDataMock as any).kind = SpanKind.SERVER;
    const actualAttributesMap: AttributeMap = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource);
    expect(actualAttributesMap).toEqual(expectedAttributesMap);
  });

  it('testLocalRootInternalSpan', () => {
    updateResourceWithServiceName();
    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as true because parentSpanContext is not valid in this test
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT, true);

    (spanDataMock as any).name = SPAN_NAME_VALUE;

    const expectedAttributesMap: AttributeMap = {};
    expectedAttributesMap[SERVICE_METRIC] = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: LOCAL_ROOT,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: INTERNAL_OPERATION,
    };

    (spanDataMock as any).kind = SpanKind.INTERNAL;
    const actualAttributesMap: AttributeMap = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource);
    expect(actualAttributesMap).toEqual(expectedAttributesMap);
  });

  it('testLocalRootClientSpan', () => {
    updateResourceWithServiceName();
    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as true because parentSpanContext is not valid in this test
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT, true);
    (spanDataMock as any).name = SPAN_NAME_VALUE;
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE, AWS_REMOTE_SERVICE_VALUE);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION, AWS_REMOTE_OPERATION_VALUE);

    const expectedAttributesMap: AttributeMap = {};

    expectedAttributesMap[SERVICE_METRIC] = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: LOCAL_ROOT,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: INTERNAL_OPERATION,
    };
    expectedAttributesMap[DEPENDENCY_METRIC] = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.CLIENT],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: INTERNAL_OPERATION,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]: AWS_REMOTE_SERVICE_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]: AWS_REMOTE_OPERATION_VALUE,
    };

    (spanDataMock as any).kind = SpanKind.CLIENT;
    const actualAttributesMap: AttributeMap = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource);
    expect(actualAttributesMap).toEqual(expectedAttributesMap);
  });

  it('testLocalRootConsumerSpan', () => {
    updateResourceWithServiceName();
    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as true because parentSpanContext is not valid in this test
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT, true);
    (spanDataMock as any).name = SPAN_NAME_VALUE;
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE, AWS_REMOTE_SERVICE_VALUE);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION, AWS_REMOTE_OPERATION_VALUE);

    const expectedAttributesMap: AttributeMap = {};

    expectedAttributesMap[SERVICE_METRIC] = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: LOCAL_ROOT,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: INTERNAL_OPERATION,
    };

    expectedAttributesMap[DEPENDENCY_METRIC] = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.CONSUMER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: INTERNAL_OPERATION,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]: AWS_REMOTE_SERVICE_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]: AWS_REMOTE_OPERATION_VALUE,
    };

    (spanDataMock as any).kind = SpanKind.CONSUMER;
    const actualAttributesMap: AttributeMap = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource);
    expect(actualAttributesMap).toEqual(expectedAttributesMap);
  });

  it('testLocalRootProducerSpan', () => {
    updateResourceWithServiceName();
    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as true because parentSpanContext is not valid in this test
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT, true);
    (spanDataMock as any).name = SPAN_NAME_VALUE;
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE, AWS_REMOTE_SERVICE_VALUE);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION, AWS_REMOTE_OPERATION_VALUE);

    const expectedAttributesMap: AttributeMap = {};

    expectedAttributesMap[SERVICE_METRIC] = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: LOCAL_ROOT,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: INTERNAL_OPERATION,
    };

    expectedAttributesMap[DEPENDENCY_METRIC] = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.PRODUCER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: INTERNAL_OPERATION,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]: AWS_REMOTE_SERVICE_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]: AWS_REMOTE_OPERATION_VALUE,
    };

    (spanDataMock as any).kind = SpanKind.PRODUCER;
    const actualAttributesMap: AttributeMap = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource);
    expect(actualAttributesMap).toEqual(expectedAttributesMap);
  });

  it('testConsumerSpanWithAttributes', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = SPAN_NAME_VALUE;

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.CONSUMER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: UNKNOWN_OPERATION,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]: UNKNOWN_REMOTE_SERVICE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]: UNKNOWN_REMOTE_OPERATION,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.CONSUMER);
  });

  it('testServerSpanWithAttributes', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = SPAN_NAME_VALUE;

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: SPAN_NAME_VALUE,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
  });

  it('testServerSpanWithNullSpanName', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = null;

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: UNKNOWN_OPERATION,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
  });

  it('testServerSpanWithSpanNameAsHttpMethod', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = 'GET';
    mockAttribute(SEMATTRS_HTTP_METHOD, 'GET');

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: UNKNOWN_OPERATION,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
    mockAttribute(SEMATTRS_HTTP_METHOD, undefined);
  });

  it('testServerSpanWithSpanNameWithHttpTarget', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = 'POST';
    mockAttribute(SEMATTRS_HTTP_METHOD, 'POST');
    mockAttribute(SEMATTRS_HTTP_TARGET, '/payment/123');

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: 'POST /payment',
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
    mockAttribute(SEMATTRS_HTTP_METHOD, undefined);
    mockAttribute(SEMATTRS_HTTP_TARGET, undefined);
  });

  // when http.target & http.url are present, the local operation should be derived from the http.target
  it('testServerSpanWithSpanNameWithTargetAndUrl', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = 'POST';
    mockAttribute(SEMATTRS_HTTP_METHOD, 'POST');
    mockAttribute(SEMATTRS_HTTP_TARGET, '/my-target/09876');
    mockAttribute(SEMATTRS_HTTP_URL, 'http://127.0.0.1:8000/payment/123');

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: 'POST /my-target',
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
    mockAttribute(SEMATTRS_HTTP_METHOD, undefined);
    mockAttribute(SEMATTRS_HTTP_TARGET, undefined);
    mockAttribute(SEMATTRS_HTTP_URL, undefined);
  });

  it('testServerSpanWithSpanNameWithHttpUrl', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = 'POST';
    mockAttribute(SEMATTRS_HTTP_METHOD, 'POST');
    mockAttribute(SEMATTRS_HTTP_URL, 'http://127.0.0.1:8000/payment/123');

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: 'POST /payment',
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
    mockAttribute(SEMATTRS_HTTP_METHOD, undefined);
    mockAttribute(SEMATTRS_HTTP_URL, undefined);
  });

  // http.url with no path should result in local operation to be "POST /"
  it('testServerSpanWithHttpUrlWithNoPath', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = 'POST';
    mockAttribute(SEMATTRS_HTTP_METHOD, 'POST');
    mockAttribute(SEMATTRS_HTTP_URL, 'http://www.example.com');

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: 'POST /',
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
    mockAttribute(SEMATTRS_HTTP_METHOD, undefined);
    mockAttribute(SEMATTRS_HTTP_URL, undefined);
  });

  // if http.url is none, local operation should default to UnknownOperation
  it('testServerSpanWithHttpUrlAsNone', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = 'POST';
    mockAttribute(SEMATTRS_HTTP_METHOD, 'POST');
    mockAttribute(SEMATTRS_HTTP_URL, undefined);

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: UNKNOWN_OPERATION,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
    mockAttribute(SEMATTRS_HTTP_METHOD, undefined);
    mockAttribute(SEMATTRS_HTTP_URL, undefined);
  });

  // if http.url is empty, local operation should default to "POST /"
  it('testServerSpanWithHttpUrlAsEmpty', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = 'POST';
    mockAttribute(SEMATTRS_HTTP_METHOD, 'POST');
    mockAttribute(SEMATTRS_HTTP_URL, '');

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: 'POST /',
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
    mockAttribute(SEMATTRS_HTTP_METHOD, undefined);
    mockAttribute(SEMATTRS_HTTP_URL, undefined);
  });

  // if http.url is invalid, local operation should default to "POST /"
  it('testServerSpanWithHttpUrlAsInvalid', () => {
    updateResourceWithServiceName();
    (spanDataMock as any).name = 'POST';
    mockAttribute(SEMATTRS_HTTP_METHOD, 'POST');
    mockAttribute(SEMATTRS_HTTP_URL, 'invalid_url');

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.SERVER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: 'POST /',
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.SERVER);
    mockAttribute(SEMATTRS_HTTP_METHOD, undefined);
    mockAttribute(SEMATTRS_HTTP_URL, undefined);
  });

  it('testProducerSpanWithAttributes', () => {
    updateResourceWithServiceName();
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION, AWS_LOCAL_OPERATION_VALUE);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE, AWS_REMOTE_SERVICE_VALUE);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION, AWS_REMOTE_OPERATION_VALUE);

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.PRODUCER],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: AWS_LOCAL_OPERATION_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]: AWS_REMOTE_SERVICE_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]: AWS_REMOTE_OPERATION_VALUE,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.PRODUCER);
  });

  it('testClientSpanWithAttributes', () => {
    updateResourceWithServiceName();
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION, AWS_LOCAL_OPERATION_VALUE);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE, AWS_REMOTE_SERVICE_VALUE);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION, AWS_REMOTE_OPERATION_VALUE);

    const expectedAttributes: Attributes = {
      [AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND]: SpanKind[SpanKind.CLIENT],
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE]: SERVICE_NAME_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION]: AWS_LOCAL_OPERATION_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]: AWS_REMOTE_SERVICE_VALUE,
      [AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]: AWS_REMOTE_OPERATION_VALUE,
    };
    validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes, SpanKind.CLIENT);
  });

  it('testRemoteAttributesCombinations', () => {
    // Set all expected fields to a test string, we will overwrite them in descending order to test
    // the priority-order logic in AwsMetricAttributeGenerator remote attribute methods.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE, 'TestString');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION, 'TestString');
    mockAttribute(SEMATTRS_RPC_SERVICE, 'TestString');
    mockAttribute(SEMATTRS_RPC_METHOD, 'TestString');
    mockAttribute(SEMATTRS_DB_SYSTEM, 'TestString');
    mockAttribute(SEMATTRS_DB_OPERATION, 'TestString');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'TestString');
    mockAttribute(SEMATTRS_FAAS_INVOKED_PROVIDER, 'TestString');
    mockAttribute(SEMATTRS_FAAS_INVOKED_NAME, 'TestString');
    mockAttribute(SEMATTRS_MESSAGING_SYSTEM, 'TestString');
    mockAttribute(SEMATTRS_MESSAGING_OPERATION, 'TestString');
    mockAttribute(_GRAPHQL_OPERATION_TYPE, 'TestString');
    // Do not set dummy value for SEMATTRS_PEER_SERVICE, since it has special behaviour.

    // Two unused attributes to show that we will not make use of unrecognized attributes
    mockAttribute('unknown.service.key', 'TestString');
    mockAttribute('unknown.operation.key', 'TestString');

    // Validate behaviour of various combinations of AWS remote attributes, then remove them.
    validateAndRemoveRemoteAttributes(
      AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE,
      AWS_REMOTE_SERVICE_VALUE,
      AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION,
      AWS_REMOTE_OPERATION_VALUE
    );

    // Validate behaviour of various combinations of RPC attributes, then remove them.
    validateAndRemoveRemoteAttributes(SEMATTRS_RPC_SERVICE, 'RPC service', SEMATTRS_RPC_METHOD, 'RPC method');

    // Validate behaviour of various combinations of DB attributes, then remove them.
    validateAndRemoveRemoteAttributes(SEMATTRS_DB_SYSTEM, 'DB system', SEMATTRS_DB_OPERATION, 'DB operation');

    // Validate db.operation not exist, but db.statement exist, where SpanAttributes.SEMATTRS_DB_STATEMENT is
    // invalid
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'invalid DB statement');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    validateAndRemoveRemoteAttributes(SEMATTRS_DB_SYSTEM, 'DB system', SEMATTRS_DB_OPERATION, UNKNOWN_REMOTE_OPERATION);

    // Validate both db.operation and db.statement not exist.
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    mockAttribute(SEMATTRS_DB_STATEMENT, undefined);
    validateAndRemoveRemoteAttributes(SEMATTRS_DB_SYSTEM, 'DB system', SEMATTRS_DB_OPERATION, UNKNOWN_REMOTE_OPERATION);

    // Validate behaviour of various combinations of FAAS attributes, then remove them.
    validateAndRemoveRemoteAttributes(
      SEMATTRS_FAAS_INVOKED_NAME,
      'FAAS invoked name',
      SEMATTRS_FAAS_TRIGGER,
      'FAAS trigger name'
    );

    // Validate behaviour of various combinations of Messaging attributes, then remove them.
    validateAndRemoveRemoteAttributes(
      SEMATTRS_MESSAGING_SYSTEM,
      'Messaging system',
      SEMATTRS_MESSAGING_OPERATION,
      'Messaging operation'
    );

    // Validate behaviour of GraphQL operation type attribute, then remove it.
    mockAttribute(_GRAPHQL_OPERATION_TYPE, 'GraphQL operation type');
    validateExpectedRemoteAttributes('graphql', 'GraphQL operation type');
    mockAttribute(_GRAPHQL_OPERATION_TYPE, undefined);

    // Validate behaviour of extracting Remote Service from net.peer.name
    mockAttribute(SEMATTRS_NET_PEER_NAME, 'www.example.com');
    validateExpectedRemoteAttributes('www.example.com', UNKNOWN_REMOTE_OPERATION);
    mockAttribute(SEMATTRS_NET_PEER_NAME, undefined);

    // Validate behaviour of extracting Remote Service from net.peer.name and net.peer.port
    mockAttribute(SEMATTRS_NET_PEER_NAME, '192.168.0.0');
    mockAttribute(SEMATTRS_NET_PEER_PORT, 8081);
    validateExpectedRemoteAttributes('192.168.0.0:8081', UNKNOWN_REMOTE_OPERATION);
    mockAttribute(SEMATTRS_NET_PEER_NAME, undefined);
    mockAttribute(SEMATTRS_NET_PEER_PORT, undefined);

    // Validate behaviour of extracting Remote Service from net.peer.socket.addr
    mockAttribute(_NET_SOCK_PEER_ADDR, 'www.example.com');
    validateExpectedRemoteAttributes('www.example.com', UNKNOWN_REMOTE_OPERATION);
    mockAttribute(_NET_SOCK_PEER_ADDR, undefined);

    // Validate behaviour of extracting Remote Service from net.peer.socket.addr and
    // net.sock.peer.port
    mockAttribute(_NET_SOCK_PEER_ADDR, '192.168.0.0');
    mockAttribute(_NET_SOCK_PEER_PORT, 8081);
    validateExpectedRemoteAttributes('192.168.0.0:8081', UNKNOWN_REMOTE_OPERATION);
    mockAttribute(_NET_SOCK_PEER_ADDR, undefined);
    mockAttribute(_NET_SOCK_PEER_PORT, undefined);

    // Validate behavior of Remote Operation from HttpTarget - with 1st api part. Also validates
    // that RemoteService is extracted from HttpUrl.
    mockAttribute(SEMATTRS_HTTP_URL, 'http://www.example.com/payment/123');
    validateExpectedRemoteAttributes('www.example.com', '/payment');
    mockAttribute(SEMATTRS_HTTP_URL, undefined);

    // Validate behavior of Remote Operation from HttpTarget - with 1st api part. Also validates
    // that RemoteService is extracted from HttpUrl.
    mockAttribute(SEMATTRS_HTTP_URL, 'http://www.example.com');
    validateExpectedRemoteAttributes('www.example.com', '/');
    mockAttribute(SEMATTRS_HTTP_URL, undefined);

    // Validate behavior of Remote Service from HttpUrl
    mockAttribute(SEMATTRS_HTTP_URL, 'http://192.168.1.1:8000');
    validateExpectedRemoteAttributes('192.168.1.1:8000', '/');
    mockAttribute(SEMATTRS_HTTP_URL, undefined);

    // Validate behavior of Remote Service from HttpUrl
    mockAttribute(SEMATTRS_HTTP_URL, 'http://192.168.1.1');
    validateExpectedRemoteAttributes('192.168.1.1', '/');
    mockAttribute(SEMATTRS_HTTP_URL, undefined);

    // Validate behavior of Remote Service from HttpUrl
    mockAttribute(SEMATTRS_HTTP_URL, '');
    validateExpectedRemoteAttributes(UNKNOWN_REMOTE_SERVICE, UNKNOWN_REMOTE_OPERATION);
    mockAttribute(SEMATTRS_HTTP_URL, undefined);

    // Validate behavior of Remote Service from HttpUrl
    mockAttribute(SEMATTRS_HTTP_URL, undefined);
    validateExpectedRemoteAttributes(UNKNOWN_REMOTE_SERVICE, UNKNOWN_REMOTE_OPERATION);
    mockAttribute(SEMATTRS_HTTP_URL, undefined);

    // Validate behavior of Remote Operation from HttpTarget - invalid url, then remove it
    mockAttribute(SEMATTRS_HTTP_URL, 'abc');
    validateExpectedRemoteAttributes(UNKNOWN_REMOTE_SERVICE, UNKNOWN_REMOTE_OPERATION);
    mockAttribute(SEMATTRS_HTTP_URL, undefined);

    // Validate behaviour of Peer service attribute, then remove it.
    mockAttribute(SEMATTRS_PEER_SERVICE, 'Peer service');
    validateExpectedRemoteAttributes('Peer service', UNKNOWN_REMOTE_OPERATION);
    mockAttribute(SEMATTRS_PEER_SERVICE, undefined);

    // Once we have removed all usable metrics, we only have "unknown" attributes, which are unused.
    validateExpectedRemoteAttributes(UNKNOWN_REMOTE_SERVICE, UNKNOWN_REMOTE_OPERATION);
  });

  // Validate behaviour of various combinations of DB attributes).
  it('testGetDBStatementRemoteOperation', () => {
    // Set all expected fields to a test string, we will overwrite them in descending order to test
    mockAttribute(SEMATTRS_DB_SYSTEM, 'TestString');
    mockAttribute(SEMATTRS_DB_OPERATION, 'TestString');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'TestString');

    // Validate SpanAttributes.SEMATTRS_DB_OPERATION not exist, but SpanAttributes.SEMATTRS_DB_STATEMENT exist,
    // where SpanAttributes.SEMATTRS_DB_STATEMENT is valid
    // Case 1: Only 1 valid keywords match
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'SELECT DB statement');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    validateExpectedRemoteAttributes('DB system', 'SELECT');

    // Case 2: More than 1 valid keywords match, we want to pick the longest match
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'DROP VIEW DB statement');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    validateExpectedRemoteAttributes('DB system', 'DROP VIEW');

    // Case 3: More than 1 valid keywords match, but the other keywords is not
    // at the start of the SpanAttributes.SEMATTRS_DB_STATEMENT. We want to only pick start match
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'SELECT data FROM domains');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    validateExpectedRemoteAttributes('DB system', 'SELECT');

    // Case 4: Have valid keywords，but it is not at the start of SpanAttributes.SEMATTRS_DB_STATEMENT
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'invalid SELECT DB statement');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    validateExpectedRemoteAttributes('DB system', UNKNOWN_REMOTE_OPERATION);

    // Case 5: Have valid keywords, match the longest word
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'UUID');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    validateExpectedRemoteAttributes('DB system', 'UUID');

    // Case 6: Have valid keywords, match with first word
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'FROM SELECT *');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    validateExpectedRemoteAttributes('DB system', 'FROM');

    // Case 7: Have valid keyword, match with first word
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'SELECT FROM *');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    validateExpectedRemoteAttributes('DB system', 'SELECT');

    // Case 8: Have valid keywords, match with upper case
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'seLeCt *');
    mockAttribute(SEMATTRS_DB_OPERATION, undefined);
    validateExpectedRemoteAttributes('DB system', 'SELECT');

    // Case 9: Both SEMATTRS_DB_OPERATION and SEMATTRS_DB_STATEMENT are set but the former takes precedence
    mockAttribute(SEMATTRS_DB_SYSTEM, 'DB system');
    mockAttribute(SEMATTRS_DB_STATEMENT, 'SELECT FROM *');
    mockAttribute(SEMATTRS_DB_OPERATION, 'DB operation');
    validateExpectedRemoteAttributes('DB system', 'DB operation');
  });

  it('testPeerServiceDoesOverrideOtherRemoteServices', () => {
    validatePeerServiceDoesOverride(SEMATTRS_RPC_SERVICE);
    validatePeerServiceDoesOverride(SEMATTRS_DB_SYSTEM);
    validatePeerServiceDoesOverride(SEMATTRS_FAAS_INVOKED_PROVIDER);
    validatePeerServiceDoesOverride(SEMATTRS_MESSAGING_SYSTEM);
    validatePeerServiceDoesOverride(_GRAPHQL_OPERATION_TYPE);
    validatePeerServiceDoesOverride(SEMATTRS_NET_PEER_NAME);
    validatePeerServiceDoesOverride(_NET_SOCK_PEER_ADDR);
    // Actually testing that peer service overrides "UnknownRemoteService".
    validatePeerServiceDoesOverride('unknown.service.key');
  });

  it('testPeerServiceDoesNotOverrideAwsRemoteService', () => {
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE, 'TestString');
    mockAttribute(SEMATTRS_PEER_SERVICE, 'PeerService');

    (spanDataMock as any).kind = SpanKind.CLIENT;
    const actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('TestString');
  });

  it('testSdkClientSpanWithRemoteResourceAttributes', () => {
    mockAttribute(SEMATTRS_RPC_SYSTEM, 'aws-api');
    // Validate behaviour of aws bucket name attribute, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET, 'aws_s3_bucket_name');
    validateRemoteResourceAttributes('AWS::S3::Bucket', 'aws_s3_bucket_name');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET, undefined);

    // Validate behaviour of AWS_SQS_QUEUE_NAME attribute, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME, 'aws_queue_name');
    validateRemoteResourceAttributes('AWS::SQS::Queue', 'aws_queue_name');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME, undefined);

    // Validate behaviour of having both AWS_SQS_QUEUE_NAME and AWS_SQS_QUEUE_URL attribute, then remove
    // them. Queue name is more reliable than queue URL, so we prefer to use name over URL.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL, 'https://sqs.us-east-2.amazonaws.com/123456789012/Queue');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME, 'aws_queue_name');
    validateRemoteResourceAttributes('AWS::SQS::Queue', 'aws_queue_name');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME, undefined);

    // Valid queue name with invalid queue URL, we should default to using the queue name.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL, 'invalidUrl');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME, 'aws_queue_name');
    validateRemoteResourceAttributes('AWS::SQS::Queue', 'aws_queue_name');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME, undefined);

    // Validate behaviour of AWS_SQS_QUEUE_URL attribute without queue name, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL, 'https://sqs.us-east-2.amazonaws.com/123456789012/MyQueue');
    validateRemoteResourceAttributes(
      'AWS::SQS::Queue',
      'MyQueue',
      'https://sqs.us-east-2.amazonaws.com/123456789012/MyQueue'
    );
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL, undefined);

    // Validate behaviour of AWS_KINESIS_STREAM_NAME attribute, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME, 'AWS_KINESIS_STREAM_NAME');
    validateRemoteResourceAttributes('AWS::Kinesis::Stream', 'AWS_KINESIS_STREAM_NAME');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME, undefined);

    // Validate behaviour of AWS_SNS_TOPIC_ARN attribute then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SNS_TOPIC_ARN, 'arn:aws:sns:us-east-1:123456789012:testTopic');
    validateRemoteResourceAttributes('AWS::SNS::Topic', 'testTopic', 'arn:aws:sns:us-east-1:123456789012:testTopic');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SNS_TOPIC_ARN, undefined);

    // Validate behaviour of AWS_SECRETSMANAGER_SECRET_ARN attributes then remove it.
    mockAttribute(
      AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN,
      'arn:aws:secretsmanager:us-east-1:123456789123:secret:testSecret'
    );
    validateRemoteResourceAttributes(
      'AWS::SecretsManager::Secret',
      'testSecret',
      'arn:aws:secretsmanager:us-east-1:123456789123:secret:testSecret'
    );
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN, undefined);

    // Validate behaviour of AWS_LAMBDA_FUNCTION_NAME and AWS_LAMBDA_FUNCTION_ARN
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME, 'aws_lambda_function_name');
    mockAttribute(
      AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_ARN,
      'arn:aws:lambda:us-east-1:123456789012:function:aws_lambda_function_name'
    );
    validateRemoteResourceAttributes(
      'AWS::Lambda::Function',
      'aws_lambda_function_name',
      'arn:aws:lambda:us-east-1:123456789012:function:aws_lambda_function_name'
    );
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_ARN, undefined);

    // Validate behaviour of AWS_LAMBDA_RESOURCE_MAPPING_ID attribute then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_RESOURCE_MAPPING_ID, 'aws_lambda_resource_mapping_id');
    validateRemoteResourceAttributes('AWS::Lambda::EventSourceMapping', 'aws_lambda_resource_mapping_id');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_RESOURCE_MAPPING_ID, undefined);

    // Validate behaviour of AWS_STEPFUNCTIONS_STATEMACHINE_ARN and AWS_STEPFUNCTIONS_ACTIVITY_ARN attributes then remove them.
    mockAttribute(
      AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_STATEMACHINE_ARN,
      'arn:aws:states:us-east-1:123456789123:stateMachine:testStateMachine'
    );
    validateRemoteResourceAttributes(
      'AWS::StepFunctions::StateMachine',
      'testStateMachine',
      'arn:aws:states:us-east-1:123456789123:stateMachine:testStateMachine'
    );
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_STATEMACHINE_ARN, undefined);

    mockAttribute(
      AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_ACTIVITY_ARN,
      'arn:aws:states:us-east-1:123456789123:activity:testActivity'
    );
    validateRemoteResourceAttributes(
      'AWS::StepFunctions::Activity',
      'testActivity',
      'arn:aws:states:us-east-1:123456789123:activity:testActivity'
    );
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_ACTIVITY_ARN, undefined);

    // Validate behaviour of AWS_TABLE_NAMES attribute with one table name, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, ['aws_table_name']);
    validateRemoteResourceAttributes('AWS::DynamoDB::Table', 'aws_table_name');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, undefined);

    // Validate behaviour of AWS_TABLE_NAMES attribute with no table name, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, []);
    validateRemoteResourceAttributes(undefined, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, undefined);

    // Validate behaviour of AWS_TABLE_NAMES attribute with two table names, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, ['aws_table_name1', 'aws_table_name2']);
    validateRemoteResourceAttributes(undefined, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, undefined);

    // Validate behaviour of AWS_TABLE_NAMES attribute with special chars(|), then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, ['aws_table|name']);
    validateRemoteResourceAttributes('AWS::DynamoDB::Table', 'aws_table^|name');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, undefined);

    // Validate behaviour of AWS_TABLE_NAMES attribute with special chars(^), then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, ['aws_table^name']);
    validateRemoteResourceAttributes('AWS::DynamoDB::Table', 'aws_table^^name');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, undefined);

    // Validate behaviour of AWS_BEDROCK_AGENT_ID attribute, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID, 'test_agent_id');
    validateRemoteResourceAttributes('AWS::Bedrock::Agent', 'test_agent_id');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, undefined);

    // Validate behaviour of AWS_BEDROCK_AGENT_ID attribute with special chars(^), then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID, 'test_agent_^id');
    validateRemoteResourceAttributes('AWS::Bedrock::Agent', 'test_agent_^^id');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID, undefined);

    // Validate behaviour of AWS_BEDROCK_DATA_SOURCE_ID attribute, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID, 'test_datasource_id');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID, 'test_kb_id');
    validateRemoteResourceAttributes('AWS::Bedrock::DataSource', 'test_datasource_id', 'test_kb_id|test_datasource_id');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID, undefined);

    // Validate behaviour of AWS_BEDROCK_DATA_SOURCE_ID attribute with special chars(^), then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID, 'test_datasource_^id');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID, 'test_kb_^id');
    validateRemoteResourceAttributes(
      'AWS::Bedrock::DataSource',
      'test_datasource_^^id',
      'test_kb_^^id|test_datasource_^^id'
    );
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID, undefined);

    // Validate behaviour of AWS_BEDROCK_GUARDRAIL_ID attribute, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ID, 'test_guardrail_id');
    mockAttribute(
      AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ARN,
      'arn:aws:bedrock:us-east-1:123456789012:guardrail/test_guardrail_id'
    );
    validateRemoteResourceAttributes(
      'AWS::Bedrock::Guardrail',
      'test_guardrail_id',
      'arn:aws:bedrock:us-east-1:123456789012:guardrail/test_guardrail_id'
    );
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ID, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ARN, undefined);

    // Validate behaviour of AWS_BEDROCK_GUARDRAIL_ID attribute with special chars(^), then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ID, 'test_guardrail_^id');
    mockAttribute(
      AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ARN,
      'arn:aws:bedrock:us-east-1:123456789012:guardrail/test_guardrail_^id'
    );
    validateRemoteResourceAttributes(
      'AWS::Bedrock::Guardrail',
      'test_guardrail_^^id',
      'arn:aws:bedrock:us-east-1:123456789012:guardrail/test_guardrail_^^id'
    );
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ID, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ARN, undefined);

    // Validate behaviour of AWS_BEDROCK_KNOWLEDGE_BASE_ID attribute, then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID, 'test_knowledgeBase_id');
    validateRemoteResourceAttributes('AWS::Bedrock::KnowledgeBase', 'test_knowledgeBase_id');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID, undefined);

    // Validate behaviour of AWS_BEDROCK_KNOWLEDGE_BASE_ID attribute with special chars(^), then remove it.
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID, 'test_knowledgeBase_^id');
    validateRemoteResourceAttributes('AWS::Bedrock::KnowledgeBase', 'test_knowledgeBase_^^id');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID, undefined);

    // Validate behaviour of GEN_AI_REQUEST_MODEL attribute, then remove it.
    mockAttribute(AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL, 'test.service_id');
    validateRemoteResourceAttributes('AWS::Bedrock::Model', 'test.service_id');
    mockAttribute(AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL, undefined);

    // Validate behaviour of GEN_AI_REQUEST_MODEL attribute with special chars(^), then remove it.
    mockAttribute(AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL, 'test.service_^id');
    validateRemoteResourceAttributes('AWS::Bedrock::Model', 'test.service_^^id');
    mockAttribute(AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL, undefined);
  });

  it('testDBClientSpanWithRemoteResourceAttributes', () => {
    mockAttribute(SEMATTRS_DB_SYSTEM, 'mysql');
    // Validate behaviour of SEMATTRS_DB_NAME, _SERVER_ADDRESS and _SERVER_PORT exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(_SERVER_ADDRESS, 'abc.com');
    mockAttribute(_SERVER_PORT, 3306);
    validateRemoteResourceAttributes('DB::Connection', 'db_name|abc.com|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(_SERVER_ADDRESS, undefined);
    mockAttribute(_SERVER_PORT, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME with '|' char, _SERVER_ADDRESS and _SERVER_PORT exist, then
    // remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name|special');
    mockAttribute(_SERVER_ADDRESS, 'abc.com');
    mockAttribute(_SERVER_PORT, 3306);
    validateRemoteResourceAttributes('DB::Connection', 'db_name^|special|abc.com|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(_SERVER_ADDRESS, undefined);
    mockAttribute(_SERVER_PORT, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME with '^' char, _SERVER_ADDRESS and _SERVER_PORT exist, then
    // remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name^special');
    mockAttribute(_SERVER_ADDRESS, 'abc.com');
    mockAttribute(_SERVER_PORT, 3306);
    validateRemoteResourceAttributes('DB::Connection', 'db_name^^special|abc.com|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(_SERVER_ADDRESS, undefined);
    mockAttribute(_SERVER_PORT, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME, _SERVER_ADDRESS exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(_SERVER_ADDRESS, 'abc.com');
    validateRemoteResourceAttributes('DB::Connection', 'db_name|abc.com');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(_SERVER_ADDRESS, undefined);

    // Validate behaviour of _SERVER_ADDRESS exist, then remove it.
    mockAttribute(_SERVER_ADDRESS, 'abc.com');
    validateRemoteResourceAttributes('DB::Connection', 'abc.com');
    mockAttribute(_SERVER_ADDRESS, undefined);

    // Validate behaviour of _SERVER_PORT exist, then remove it.
    mockAttribute(_SERVER_PORT, 3306);
    (spanDataMock as any).kind = SpanKind.CLIENT;
    let actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toBeUndefined();
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toBeUndefined();
    mockAttribute(_SERVER_PORT, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME, SEMATTRS_NET_PEER_NAME and SEMATTRS_NET_PEER_PORT exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(SEMATTRS_NET_PEER_NAME, 'abc.com');
    mockAttribute(SEMATTRS_NET_PEER_PORT, 3306);
    validateRemoteResourceAttributes('DB::Connection', 'db_name|abc.com|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_NET_PEER_NAME, undefined);
    mockAttribute(SEMATTRS_NET_PEER_PORT, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME, SEMATTRS_NET_PEER_NAME exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(SEMATTRS_NET_PEER_NAME, 'abc.com');
    validateRemoteResourceAttributes('DB::Connection', 'db_name|abc.com');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_NET_PEER_NAME, undefined);

    // Validate behaviour of SEMATTRS_NET_PEER_NAME exist, then remove it.
    mockAttribute(SEMATTRS_NET_PEER_NAME, 'abc.com');
    validateRemoteResourceAttributes('DB::Connection', 'abc.com');
    mockAttribute(SEMATTRS_NET_PEER_NAME, undefined);

    // Validate behaviour of SEMATTRS_NET_PEER_PORT exist, then remove it.
    mockAttribute(SEMATTRS_NET_PEER_PORT, 3306);
    (spanDataMock as any).kind = SpanKind.CLIENT;
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toBeUndefined();
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toBeUndefined();
    mockAttribute(SEMATTRS_NET_PEER_PORT, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME, _SERVER_SOCKET_ADDRESS and _SERVER_SOCKET_PORT exist, then
    // remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(_SERVER_SOCKET_ADDRESS, 'abc.com');
    mockAttribute(_SERVER_SOCKET_PORT, 3306);
    validateRemoteResourceAttributes('DB::Connection', 'db_name|abc.com|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(_SERVER_SOCKET_ADDRESS, undefined);
    mockAttribute(_SERVER_SOCKET_PORT, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME, _SERVER_SOCKET_ADDRESS exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(_SERVER_SOCKET_ADDRESS, 'abc.com');
    validateRemoteResourceAttributes('DB::Connection', 'db_name|abc.com');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(_SERVER_SOCKET_ADDRESS, undefined);

    // Validate behaviour of _SERVER_SOCKET_PORT exist, then remove it.
    mockAttribute(_SERVER_SOCKET_PORT, 3306);
    (spanDataMock as any).kind = SpanKind.CLIENT;
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toBeUndefined();
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toBeUndefined();
    mockAttribute(_SERVER_SOCKET_PORT, undefined);

    // Validate behaviour of only SEMATTRS_DB_NAME exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    (spanDataMock as any).kind = SpanKind.CLIENT;
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toBeUndefined();
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toBeUndefined();
    mockAttribute(SEMATTRS_DB_NAME, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME and SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(
      SEMATTRS_DB_CONNECTION_STRING,
      'mysql://test-apm.cluster-cnrw3s3ddo7n.us-east-1.rds.amazonaws.com:3306/petclinic'
    );
    validateRemoteResourceAttributes(
      'DB::Connection',
      'db_name|test-apm.cluster-cnrw3s3ddo7n.us-east-1.rds.amazonaws.com|3306'
    );
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    // Validate behaviour of SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(
      SEMATTRS_DB_CONNECTION_STRING,
      'mysql://test-apm.cluster-cnrw3s3ddo7n.us-east-1.rds.amazonaws.com:3306/petclinic'
    );
    validateRemoteResourceAttributes(
      'DB::Connection',
      'test-apm.cluster-cnrw3s3ddo7n.us-east-1.rds.amazonaws.com|3306'
    );
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    // Validate behaviour of SEMATTRS_DB_CONNECTION_STRING exist without port, then remove it.
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, 'http://dbserver');
    validateRemoteResourceAttributes('DB::Connection', 'dbserver');
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME and invalid SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, 'hsqldb:mem:');
    (spanDataMock as any).kind = SpanKind.CLIENT;
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toBeUndefined();
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toBeUndefined();
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    mockAttribute(SEMATTRS_DB_SYSTEM, undefined);
  });

  function mockAttribute(key: string, value: AttributeValue | undefined): void {
    attributesMock[key] = value;
  }

  function validateAttributesProducedForNonLocalRootSpanOfKind(expectedAttributes: Attributes, kind: SpanKind): void {
    (spanDataMock as any).kind = kind;
    const attributeMap: AttributeMap = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource);
    const serviceAttributes: Attributes = attributeMap[SERVICE_METRIC];
    const dependencyAttributes: Attributes = attributeMap[DEPENDENCY_METRIC];
    if (Object.keys(attributeMap).length !== 0) {
      if (SpanKind.PRODUCER === kind || SpanKind.CLIENT === kind || SpanKind.CONSUMER === kind) {
        expect(serviceAttributes).toBeUndefined();
        expect(dependencyAttributes).toEqual(expectedAttributes);
        expect(Object.keys(dependencyAttributes).length).toEqual(Object.keys(expectedAttributes).length);
      } else {
        expect(serviceAttributes).toEqual(expectedAttributes);
        expect(Object.keys(serviceAttributes).length).toEqual(Object.keys(expectedAttributes).length);
        expect(dependencyAttributes).toBeUndefined();
      }
    }
  }

  function updateResourceWithServiceName(): void {
    resource.attributes[SEMRESATTRS_SERVICE_NAME] = SERVICE_NAME_VALUE;
  }

  function validateExpectedRemoteAttributes(expectedRemoteService: string, expectedRemoteOperation: string): void {
    (spanDataMock as any).kind = SpanKind.CLIENT;
    let actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual(expectedRemoteService);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual(expectedRemoteOperation);

    (spanDataMock as any).kind = SpanKind.PRODUCER;
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual(expectedRemoteService);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual(expectedRemoteOperation);
  }

  function validateAndRemoveRemoteAttributes(
    remoteServiceKey: string,
    remoteServiceValue: string,
    remoteOperationKey: string,
    remoteOperationValue: string
  ): void {
    mockAttribute(remoteServiceKey, remoteServiceValue);
    mockAttribute(remoteOperationKey, remoteOperationValue);
    validateExpectedRemoteAttributes(remoteServiceValue, remoteOperationValue);

    mockAttribute(remoteServiceKey, undefined);
    mockAttribute(remoteOperationKey, remoteOperationValue);
    validateExpectedRemoteAttributes(UNKNOWN_REMOTE_SERVICE, remoteOperationValue);

    mockAttribute(remoteServiceKey, remoteServiceValue);
    mockAttribute(remoteOperationKey, undefined);
    validateExpectedRemoteAttributes(remoteServiceValue, UNKNOWN_REMOTE_OPERATION);

    mockAttribute(remoteServiceKey, undefined);
    mockAttribute(remoteOperationKey, undefined);
  }

  function validatePeerServiceDoesOverride(remoteServiceKey: string): void {
    mockAttribute(remoteServiceKey, 'TestString');
    mockAttribute(SEMATTRS_PEER_SERVICE, 'PeerService');

    // Validate that peer service value takes precedence over whatever remoteServiceKey was set
    (spanDataMock as any).kind = SpanKind.CLIENT;
    const actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('PeerService');

    mockAttribute(remoteServiceKey, undefined);
    mockAttribute(SEMATTRS_PEER_SERVICE, undefined);
  }

  function validateRemoteResourceAttributes(
    type: string | undefined,
    identifier: string | undefined,
    cfnPrimaryId: string | undefined = undefined
  ): void {
    // If cfnPrimaryId is not provided, it defaults to identifier
    if (cfnPrimaryId === undefined) {
      cfnPrimaryId = identifier;
    }

    // Client, Producer and Consumer spans should generate the expected remote resource attributes
    (spanDataMock as any).kind = SpanKind.CLIENT;
    let actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toEqual(type);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toEqual(identifier);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_CLOUDFORMATION_PRIMARY_IDENTIFIER]).toEqual(cfnPrimaryId);

    (spanDataMock as any).kind = SpanKind.PRODUCER;
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toEqual(type);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toEqual(identifier);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_CLOUDFORMATION_PRIMARY_IDENTIFIER]).toEqual(cfnPrimaryId);

    (spanDataMock as any).kind = SpanKind.CONSUMER;
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toEqual(type);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toEqual(identifier);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_CLOUDFORMATION_PRIMARY_IDENTIFIER]).toEqual(cfnPrimaryId);

    // Server span should not generate remote resource attributes
    (spanDataMock as any).kind = SpanKind.SERVER;
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[SERVICE_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toEqual(undefined);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toEqual(undefined);
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_CLOUDFORMATION_PRIMARY_IDENTIFIER]).toEqual(undefined);
  }

  it('testDBUserAttribute', () => {
    mockAttribute(SEMATTRS_DB_OPERATION, 'db_operation');
    mockAttribute(SEMATTRS_DB_USER, 'db_user');
    (spanDataMock as any).kind = SpanKind.CLIENT;

    const actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual('db_operation');
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_DB_USER]).toEqual('db_user');
  });

  it('testDBUserAttributeAbsent', () => {
    mockAttribute(SEMATTRS_DB_SYSTEM, 'db_system');
    (spanDataMock as any).kind = SpanKind.CLIENT;

    const actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_DB_USER]).toBeUndefined();
  });

  it('testDBUserAttributeWithDifferentValues', () => {
    mockAttribute(SEMATTRS_DB_OPERATION, 'db_operation');
    mockAttribute(SEMATTRS_DB_USER, 'non_db_user');
    (spanDataMock as any).kind = SpanKind.CLIENT;

    const actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_DB_USER]).toEqual('non_db_user');
  });

  it('testDBUserAttributeNotPresentInServiceMetricForServerSpan', () => {
    mockAttribute(SEMATTRS_DB_USER, 'db_user');
    mockAttribute(SEMATTRS_DB_SYSTEM, 'db_system');
    (spanDataMock as any).kind = SpanKind.SERVER;

    const actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      SERVICE_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_DB_USER]).toBeUndefined();
  });

  it('testDbUserPresentAndIsDbSpanFalse', () => {
    mockAttribute(SEMATTRS_DB_USER, 'DB user');
    (spanDataMock as any).kind = SpanKind.CLIENT;

    const actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_DB_USER]).toBeUndefined();
  });

  it('testNormalizeRemoteServiceName_NoNormalization', () => {
    const serviceName: string = 'non aws service';
    mockAttribute(SEMATTRS_RPC_SERVICE, serviceName);
    (spanDataMock as any).kind = SpanKind.CLIENT;

    const actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual(serviceName);
  });

  it('testNormalizeRemoteServiceName_AwsSdk', () => {
    testAwsSdkServiceNormalization('DynamoDB', 'AWS::DynamoDB');
    testAwsSdkServiceNormalization('Kinesis', 'AWS::Kinesis');
    testAwsSdkServiceNormalization('S3', 'AWS::S3');
    testAwsSdkServiceNormalization('SQS', 'AWS::SQS');
    testAwsSdkServiceNormalization('SNS', 'AWS::SNS');
    testAwsSdkServiceNormalization('Lambda', 'AWS::Lambda');
    testAwsSdkServiceNormalization('SecretsManager', 'AWS::SecretsManager');
    testAwsSdkServiceNormalization('SFN', 'AWS::StepFunctions');
    testAwsSdkServiceNormalization('Bedrock', 'AWS::Bedrock');
    testAwsSdkServiceNormalization('BedrockAgent', 'AWS::Bedrock');
    testAwsSdkServiceNormalization('BedrockAgentRuntime', 'AWS::Bedrock');
    testAwsSdkServiceNormalization('BedrockRuntime', 'AWS::BedrockRuntime');
  });

  function testAwsSdkServiceNormalization(serviceName: string, expectedRemoteService: string): void {
    mockAttribute(SEMATTRS_RPC_SYSTEM, 'aws-api');
    mockAttribute(SEMATTRS_RPC_SERVICE, serviceName);
    (spanDataMock as any).kind = SpanKind.CLIENT;

    const actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual(expectedRemoteService);
  }

  it('testNoMetricWhenConsumerProcessWithConsumerParent', () => {
    attributesMock[AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND] = SpanKind[SpanKind.CONSUMER];
    attributesMock[SEMATTRS_MESSAGING_OPERATION] = MESSAGINGOPERATIONVALUES_PROCESS;
    (spanDataMock as any).kind = SpanKind.CONSUMER;

    const attributeMap: AttributeMap = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource);

    const serviceAttributes: Attributes = attributeMap[SERVICE_METRIC];
    const dependencyAttributes: Attributes = attributeMap[DEPENDENCY_METRIC];

    expect(serviceAttributes).toBeUndefined();
    expect(dependencyAttributes).toBeUndefined();
  });

  it('testBothMetricsWhenLocalRootConsumerProcess', () => {
    attributesMock[AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND] = SpanKind[SpanKind.CONSUMER];
    attributesMock[SEMATTRS_MESSAGING_OPERATION] = MESSAGINGOPERATIONVALUES_PROCESS;
    (spanDataMock as any).kind = SpanKind.CONSUMER;
    // Divergence from Java/Python - set AWS_IS_LOCAL_ROOT as true because parentSpanContext is not valid in this test
    attributesMock[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = true;

    const attributeMap: AttributeMap = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource);

    const serviceAttributes: Attributes = attributeMap[SERVICE_METRIC];
    const dependencyAttributes: Attributes = attributeMap[DEPENDENCY_METRIC];

    expect(attributeMap[SERVICE_METRIC]).toEqual(serviceAttributes);
    expect(attributeMap[DEPENDENCY_METRIC]).toEqual(dependencyAttributes);
  });

  it('testCloudformationPrimaryIdentifierFallbackToRemoteResourceIdentifier', () => {
    // Test that when cloudformationPrimaryIdentifier is not explicitly set,
    // it falls back to use the same value as remoteResourceIdentifier.
    mockAttribute(SEMATTRS_RPC_SYSTEM, 'aws-api');
    (spanDataMock as any).kind = SpanKind.CLIENT;

    // Test case 1: S3 Bucket (no ARN available, should use bucket name for both)
    mockAttribute(SEMATTRS_RPC_SERVICE, 'S3');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET, 'my-test-bucket');
    validateRemoteResourceAttributes('AWS::S3::Bucket', 'my-test-bucket');

    // Test S3 bucket with special characters
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET, 'my-test|bucket^name');
    validateRemoteResourceAttributes('AWS::S3::Bucket', 'my-test^|bucket^^name');
    mockAttribute(SEMATTRS_RPC_SERVICE, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET, undefined);

    // Test case 2: SQS Queue by name (no ARN, should use queue name for both)
    mockAttribute(SEMATTRS_RPC_SERVICE, 'SQS');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME, 'my-test-queue');
    validateRemoteResourceAttributes('AWS::SQS::Queue', 'my-test-queue');

    // Test SQS queue with special characters
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME, 'my^queue|name');
    validateRemoteResourceAttributes('AWS::SQS::Queue', 'my^^queue^|name');
    mockAttribute(SEMATTRS_RPC_SERVICE, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME, undefined);

    // Test case 3: DynamoDB Table (no ARN, should use table name for both)
    mockAttribute(SEMATTRS_RPC_SERVICE, 'DynamoDB');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, ['my-test-table']);
    validateRemoteResourceAttributes('AWS::DynamoDB::Table', 'my-test-table');

    // Test DynamoDB table with special characters
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, ['my|test^table']);
    validateRemoteResourceAttributes('AWS::DynamoDB::Table', 'my^|test^^table');
    mockAttribute(SEMATTRS_RPC_SERVICE, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES, undefined);

    // Test case 4: Kinesis Stream
    mockAttribute(SEMATTRS_RPC_SERVICE, 'Kinesis');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME, 'my-test-stream');
    validateRemoteResourceAttributes('AWS::Kinesis::Stream', 'my-test-stream');

    // Test Kinesis stream with special characters
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME, 'my-stream^with|chars');
    validateRemoteResourceAttributes('AWS::Kinesis::Stream', 'my-stream^^with^|chars');
    mockAttribute(SEMATTRS_RPC_SERVICE, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME, undefined);

    // Test case 5: Lambda Function (non-invoke operation, no ARN)
    mockAttribute(SEMATTRS_RPC_SERVICE, 'Lambda');
    mockAttribute(SEMATTRS_RPC_METHOD, 'GetFunction');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME, 'my-test-function');
    validateRemoteResourceAttributes('AWS::Lambda::Function', 'my-test-function');

    // Test Lambda function with special characters
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME, 'my-function|with^chars');
    validateRemoteResourceAttributes('AWS::Lambda::Function', 'my-function^|with^^chars');
    mockAttribute(SEMATTRS_RPC_SERVICE, undefined);
    mockAttribute(SEMATTRS_RPC_METHOD, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME, undefined);

    mockAttribute(SEMATTRS_RPC_SYSTEM, undefined);
  });

  it('testSetRemoteEnvironment', () => {
    // Test remote environment setting for Lambda invoke operations.

    // Test 1: Setting remote environment when all relevant attributes are present
    (spanDataMock as any).kind = SpanKind.CLIENT;
    mockAttribute(SEMATTRS_RPC_SYSTEM, 'aws-api');
    mockAttribute(SEMATTRS_RPC_SERVICE, 'Lambda');
    mockAttribute(SEMATTRS_RPC_METHOD, 'Invoke');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME, 'testFunction');

    let actualAttributes: Attributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[
      DEPENDENCY_METRIC
    ];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_ENVIRONMENT]).toEqual('lambda:default');

    // Test 2: NOT setting it when RPC_SYSTEM is missing
    mockAttribute(SEMATTRS_RPC_SYSTEM, undefined);
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_ENVIRONMENT]).toBeUndefined();
    mockAttribute(SEMATTRS_RPC_SYSTEM, 'aws-api');

    // Test 3: NOT setting it when RPC_METHOD is missing
    mockAttribute(SEMATTRS_RPC_METHOD, undefined);
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_ENVIRONMENT]).toBeUndefined();
    mockAttribute(SEMATTRS_RPC_METHOD, 'Invoke');

    // Test 4: Still setting it to lambda:default when AWS_LAMBDA_FUNCTION_NAME is missing
    // Keep the other attributes but remove AWS_LAMBDA_FUNCTION_NAME
    mockAttribute(SEMATTRS_RPC_SYSTEM, 'aws-api');
    mockAttribute(SEMATTRS_RPC_SERVICE, 'Lambda');
    mockAttribute(SEMATTRS_RPC_METHOD, 'Invoke');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME, undefined);

    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_ENVIRONMENT]).toEqual('lambda:default');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME, 'testFunction');

    // Test 5: NOT setting it for non-Lambda services
    mockAttribute(SEMATTRS_RPC_SERVICE, 'S3');
    mockAttribute(SEMATTRS_RPC_METHOD, 'GetObject');
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_ENVIRONMENT]).toBeUndefined();

    // Test 6: NOT setting it for Lambda non-Invoke operations
    mockAttribute(SEMATTRS_RPC_SERVICE, 'Lambda');
    mockAttribute(SEMATTRS_RPC_METHOD, 'GetFunction');
    actualAttributes = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource)[DEPENDENCY_METRIC];
    expect(actualAttributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_ENVIRONMENT]).toBeUndefined();

    // Clean up
    mockAttribute(SEMATTRS_RPC_SYSTEM, undefined);
    mockAttribute(SEMATTRS_RPC_SERVICE, undefined);
    mockAttribute(SEMATTRS_RPC_METHOD, undefined);
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME, undefined);
  });

  it('testJdbcDbConnectionString', () => {
    mockAttribute(SEMATTRS_DB_SYSTEM, 'mysql');

    // Validate behaviour of SEMATTRS_DB_NAME and SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(
      SEMATTRS_DB_CONNECTION_STRING,
      'jdbc:mysql://mysql.db.server:3306/my_database?useSSL=false&serverTimezone=UTC'
    );
    validateRemoteResourceAttributes('DB::Connection', 'db_name|mysql.db.server|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME and SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, 'jdbc:mysql://myhostname:3306/db_name?prop1=value1&prop2=value2');
    validateRemoteResourceAttributes('DB::Connection', 'db_name|myhostname|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME and SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, 'jdbc:mysql://root:mypassword@myhostname:3306/db_name');
    validateRemoteResourceAttributes('DB::Connection', 'db_name|myhostname|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME and SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, 'jdbc:postgresql://host:3306/database?properties');
    validateRemoteResourceAttributes('DB::Connection', 'db_name|host|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME and SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(
      SEMATTRS_DB_CONNECTION_STRING,
      'jdbc:postgresql://postgresql.db.server:3306/mydatabase?ssl=true&loglevel=1'
    );
    validateRemoteResourceAttributes('DB::Connection', 'db_name|postgresql.db.server|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME and SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, 'jdbc://myhostname:3306/db_name?user=root&password=mypassword');
    validateRemoteResourceAttributes('DB::Connection', 'db_name|myhostname|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    // Validate behaviour of SEMATTRS_DB_NAME and SEMATTRS_DB_CONNECTION_STRING exist, then remove it.
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(
      SEMATTRS_DB_CONNECTION_STRING,
      'jdbc:mysql:loadbalance://myhostname:3306/db_name?user=root&password=mypassword'
    );
    validateRemoteResourceAttributes('DB::Connection', 'db_name|myhostname|3306');
    mockAttribute(SEMATTRS_DB_NAME, undefined);
    mockAttribute(SEMATTRS_DB_CONNECTION_STRING, undefined);

    mockAttribute(SEMATTRS_DB_SYSTEM, undefined);
  });
});
