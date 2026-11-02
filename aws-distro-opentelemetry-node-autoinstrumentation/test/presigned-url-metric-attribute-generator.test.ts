// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Generator-level wiring tests for presigned AWS URL attribution.
//
// These exercise AwsMetricAttributeGenerator end to end (config gating, AWS-SDK exclusion, remote
// resource reuse, and suppression of the generic HTTP operation fallback), complementing the
// component tests for the parser and the S3 attributor.

import { AttributeValue, Attributes, SpanContext, SpanKind } from '@opentelemetry/api';
import type { InstrumentationScope } from '@opentelemetry/core';
import { Resource, defaultResource } from '@opentelemetry/resources';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  SEMATTRS_DB_NAME,
  SEMATTRS_DB_SYSTEM,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_URL,
  SEMATTRS_PEER_SERVICE,
  SEMATTRS_RPC_SYSTEM,
} from '@opentelemetry/semantic-conventions';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../src/aws-attribute-keys';
import { AwsMetricAttributeGenerator } from '../src/aws-metric-attribute-generator';
import { AttributeMap, DEPENDENCY_METRIC } from '../src/metric-attribute-generator';

const PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG: string =
  'OTEL_AWS_APPLICATION_SIGNALS_PRESIGNED_URL_ATTRIBUTION_ENABLED';
const UNKNOWN_REMOTE_OPERATION: string = 'UnknownRemoteOperation';
const ATTR_URL_FULL: string = 'url.full';
const ATTR_HTTP_REQUEST_METHOD: string = 'http.request.method';
const _SERVER_ADDRESS: string = 'server.address';
const _SERVER_PORT: string = 'server.port';

const GENERATOR: AwsMetricAttributeGenerator = new AwsMetricAttributeGenerator();

// A realistic sanitized presigned URL: the agent redacts the credential and signature values before
// metric attribution runs. The non-redacted presigned parameters remain.
function presignedUrl(host: string, path: string): string {
  return (
    'https://' +
    host +
    path +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    '&X-Amz-Credential=REDACTED' +
    '&X-Amz-Signature=REDACTED' +
    '&X-Amz-Date=20260710T120000Z' +
    '&X-Amz-Expires=3600' +
    '&X-Amz-SignedHeaders=host'
  );
}

describe('PresignedUrlMetricAttributeGeneratorTest', () => {
  let attributesMock: Attributes;
  let spanDataMock: ReadableSpan;
  let instrumentationScopeMock: InstrumentationScope;
  let resource: Resource;

  beforeEach(() => {
    attributesMock = {};
    instrumentationScopeMock = { name: 'Scope name' };
    spanDataMock = {
      name: 'spanDataMockName',
      kind: SpanKind.CLIENT,
      spanContext: () => {
        const spanContext: SpanContext = {
          traceId: '00000000000000000000000000000008',
          spanId: '0000000000000009',
          traceFlags: 0,
        };
        return spanContext;
      },
      parentSpanContext: {
        traceId: '00000000000000000000000000000008',
        spanId: '0000000000000007',
        traceFlags: 0,
      },
      startTime: [0, 0],
      endTime: [0, 1],
      status: { code: 0 },
      attributes: attributesMock,
      links: [],
      events: [],
      duration: [0, 1],
      ended: true,
      resource: defaultResource(),
      instrumentationScope: instrumentationScopeMock,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    attributesMock[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = false;
    resource = defaultResource();
  });

  afterEach(() => {
    delete process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG];
  });

  function mockAttribute(key: string, value: AttributeValue | undefined): void {
    attributesMock[key] = value;
  }

  function dependencyAttributes(): Attributes {
    const attributeMap: AttributeMap = GENERATOR.generateMetricAttributeMapFromSpan(spanDataMock, resource);
    return attributeMap[DEPENDENCY_METRIC];
  }

  it('presignedS3AttributionDisabledByDefault', () => {
    delete process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG];
    mockAttribute(SEMATTRS_HTTP_URL, presignedUrl('example-bucket.s3.us-west-2.amazonaws.com', '/object'));
    mockAttribute(SEMATTRS_HTTP_METHOD, 'PUT');

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('example-bucket.s3.us-west-2.amazonaws.com');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual('PUT /object');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toBeUndefined();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toBeUndefined();
  });

  it('presignedS3UrlAttributes', () => {
    process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG] = 'true';
    mockAttribute(ATTR_URL_FULL, presignedUrl('example-bucket.s3.us-west-2.amazonaws.com', '/object'));
    mockAttribute(ATTR_HTTP_REQUEST_METHOD, 'GET');

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('AWS::S3');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual('GetObject');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toEqual('AWS::S3::Bucket');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toEqual('example-bucket');
  });

  it('presignedS3UrlUnknownOperationDoesNotFallBackToHttpPath', () => {
    // Bucket-level GET (no object key) is ambiguous, so the resolver returns UnknownRemoteOperation.
    // The generic HTTP operation fallback must not overwrite it with a high-cardinality "GET /..."
    // value.
    process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG] = 'true';
    mockAttribute(ATTR_URL_FULL, presignedUrl('example-bucket.s3.us-west-2.amazonaws.com', '/'));
    mockAttribute(ATTR_HTTP_REQUEST_METHOD, 'GET');

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('AWS::S3');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual(UNKNOWN_REMOTE_OPERATION);
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toEqual('AWS::S3::Bucket');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toEqual('example-bucket');
  });

  it('presignedS3UrlUsesLegacyHttpUrlFallback', () => {
    process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG] = 'true';
    mockAttribute(SEMATTRS_HTTP_URL, presignedUrl('example-bucket.s3.us-west-2.amazonaws.com', '/object'));
    mockAttribute(SEMATTRS_HTTP_METHOD, 'HEAD');

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('AWS::S3');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual('HeadObject');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toEqual('AWS::S3::Bucket');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toEqual('example-bucket');
  });

  it('presignedS3UrlExplicitRemoteAttributesWin', () => {
    process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG] = 'true';
    mockAttribute(ATTR_URL_FULL, presignedUrl('example-bucket.s3.us-west-2.amazonaws.com', '/object'));
    mockAttribute(ATTR_HTTP_REQUEST_METHOD, 'PUT');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE, 'AWS remote service');
    mockAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION, 'AWS remote operation');

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('AWS remote service');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual('AWS remote operation');
  });

  it('presignedS3UrlDoesNotAttributeAwsSdkSpan', () => {
    // An AWS SDK span (rpc.system=aws-api) must be excluded from presigned attribution even when its
    // rpc.service/rpc.method are absent, so it keeps the generic HTTP attribution.
    process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG] = 'true';
    mockAttribute(SEMATTRS_HTTP_URL, presignedUrl('example-bucket.s3.us-west-2.amazonaws.com', '/object'));
    mockAttribute(SEMATTRS_HTTP_METHOD, 'GET');
    mockAttribute(SEMATTRS_RPC_SYSTEM, 'aws-api');

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('example-bucket.s3.us-west-2.amazonaws.com');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual('GET /object');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toBeUndefined();
  });

  it('presignedS3UrlPeerServiceOverrideIsUnchanged', () => {
    process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG] = 'true';
    mockAttribute(ATTR_URL_FULL, presignedUrl('example-bucket.s3.us-west-2.amazonaws.com', '/object'));
    mockAttribute(ATTR_HTTP_REQUEST_METHOD, 'PUT');
    mockAttribute(SEMATTRS_PEER_SERVICE, 'PeerService');

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('PeerService');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual('PutObject');
    // peer.service overrides the remote service but not the resource, mirroring the SDK path: the
    // S3 bucket resource stays attached even though the service is now the peer value.
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toEqual('AWS::S3::Bucket');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toEqual('example-bucket');
  });

  it('nonS3PresignedEndpointIsUnchanged', () => {
    process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG] = 'true';
    mockAttribute(SEMATTRS_HTTP_URL, presignedUrl('sqs.us-west-2.amazonaws.com', '/123456789012/example-queue'));
    mockAttribute(SEMATTRS_HTTP_METHOD, 'GET');

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual('sqs.us-west-2.amazonaws.com');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual('GET /123456789012');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toBeUndefined();
  });

  it('presignedS3UrlWithUnrecognizedEndpointIsUnchanged', () => {
    // An access-point host is not a recognized bucket-bearing S3 endpoint. Attribution fails closed
    // and the span keeps the existing generic HTTP attribution.
    process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG] = 'true';
    mockAttribute(SEMATTRS_HTTP_URL, presignedUrl('example-bucket.s3-accesspoint.us-west-2.amazonaws.com', '/object'));
    mockAttribute(SEMATTRS_HTTP_METHOD, 'GET');

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE]).toEqual(
      'example-bucket.s3-accesspoint.us-west-2.amazonaws.com'
    );
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION]).toEqual('GET /object');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toBeUndefined();
  });

  it('dbResourceAttributionUnaffectedWhenPresignedAttributionEnabled', () => {
    // Enabling presigned attribution must not shadow DB resource attribution.
    process.env[PRESIGNED_URL_ATTRIBUTION_ENABLED_CONFIG] = 'true';
    mockAttribute(SEMATTRS_DB_SYSTEM, 'mysql');
    mockAttribute(SEMATTRS_DB_NAME, 'db_name');
    mockAttribute(_SERVER_ADDRESS, 'abc.com');
    mockAttribute(_SERVER_PORT, 3306);

    const attributes = dependencyAttributes();
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE]).toEqual('DB::Connection');
    expect(attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER]).toEqual('db_name|abc.com|3306');
  });
});
