// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import * as assert from 'assert';
import { buildAttributes } from '../src/span-metrics-attributes-builder';
import { LIB_VERSION } from '../src/identity';
import { fakeSpan } from './test-utils';

describe('SpanMetricsAttributesBuilder', () => {
  it('emits the base dimensions in short form plus schema/lib markers', () => {
    const attrs = buildAttributes(
      fakeSpan({ name: 'GET /x', kind: SpanKind.CLIENT, statusCode: SpanStatusCode.ERROR })
    );
    assert.strictEqual(attrs['span.name'], 'GET /x');
    assert.strictEqual(attrs['span.kind'], 'CLIENT');
    assert.strictEqual(attrs['status.code'], 'ERROR');
    assert.strictEqual(attrs['aws.otel.span.metrics.schema'], 'v1');
    assert.strictEqual(attrs['aws.otel.extension.lib.version'], LIB_VERSION);
  });

  it('maps every span kind and status code to its short form', () => {
    const kinds: Array<[SpanKind, string]> = [
      [SpanKind.INTERNAL, 'INTERNAL'],
      [SpanKind.SERVER, 'SERVER'],
      [SpanKind.CLIENT, 'CLIENT'],
      [SpanKind.PRODUCER, 'PRODUCER'],
      [SpanKind.CONSUMER, 'CONSUMER'],
    ];
    for (const [kind, name] of kinds) {
      assert.strictEqual(buildAttributes(fakeSpan({ kind }))['span.kind'], name);
    }
    const statuses: Array<[SpanStatusCode, string]> = [
      [SpanStatusCode.UNSET, 'UNSET'],
      [SpanStatusCode.OK, 'OK'],
      [SpanStatusCode.ERROR, 'ERROR'],
    ];
    for (const [code, name] of statuses) {
      assert.strictEqual(buildAttributes(fakeSpan({ statusCode: code }))['status.code'], name);
    }
  });

  it('never emits service.name as a datapoint attribute (it lives on the metric resource)', () => {
    // Even when the span's resource carries service.name, the datapoint must not duplicate it: the
    // metrics are recorded into the host MeterProvider, whose resource already has service.name.
    const withResource = buildAttributes(fakeSpan({ resourceAttributes: { 'service.name': 'svc' } }));
    assert.ok(!('service.name' in withResource));
    const withoutResource = buildAttributes(fakeSpan({ resourceAttributes: {} }));
    assert.ok(!('service.name' in withoutResource));
  });

  it('copies each allowlisted attribute only when present', () => {
    const attrs = buildAttributes(
      fakeSpan({
        attributes: {
          'http.request.method': 'GET',
          'http.route': '/owners/:id',
          'rpc.system': 'grpc',
          'rpc.service': 'Svc',
          'rpc.method': 'M',
          'messaging.system': 'kafka',
          'messaging.operation.name': 'send',
          'error.type': '500',
        },
      })
    );
    assert.strictEqual(attrs['http.request.method'], 'GET');
    assert.strictEqual(attrs['http.route'], '/owners/:id');
    assert.strictEqual(attrs['rpc.system'], 'grpc', 'legacy rpc.system passes through via fallback');
    assert.strictEqual(attrs['rpc.method'], 'M');
    assert.strictEqual(attrs['messaging.operation.name'], 'send');
    assert.strictEqual(attrs['error.type'], '500');
    // Absent allowlisted keys are not synthesized.
    assert.ok(!('db.system.name' in attrs));
  });

  it('preserves http.response.status_code as a number (int semconv type)', () => {
    const attrs = buildAttributes(fakeSpan({ attributes: { 'http.response.status_code': 200 } }));
    assert.strictEqual(attrs['http.response.status_code'], 200);
    assert.strictEqual(typeof attrs['http.response.status_code'], 'number');
  });

  it('does not copy non-allowlisted (high-cardinality) attributes', () => {
    const attrs = buildAttributes(
      fakeSpan({ attributes: { 'db.statement': 'SELECT *', 'http.url': 'http://x/y?z=1' } })
    );
    assert.ok(!('db.statement' in attrs));
    assert.ok(!('http.url' in attrs));
  });

  it('passes legacy db keys through unchanged when current keys are absent', () => {
    const attrs = buildAttributes(
      fakeSpan({
        kind: SpanKind.CLIENT,
        attributes: { 'db.system': 'h2', 'db.operation': 'SELECT', 'db.sql.table': 'items' },
      })
    );
    // Legacy key + value, not re-homed to the current key.
    assert.strictEqual(attrs['db.system'], 'h2');
    assert.strictEqual(attrs['db.operation'], 'SELECT');
    assert.strictEqual(attrs['db.sql.table'], 'items');
    assert.ok(!('db.system.name' in attrs));
    assert.ok(!('db.operation.name' in attrs));
    assert.ok(!('db.collection.name' in attrs));
  });

  it('passes legacy http keys through unchanged when current keys are absent', () => {
    // Legacy-semconv HTTP instrumentation (pre-1.21 defaults) emits http.method/http.status_code.
    const attrs = buildAttributes(
      fakeSpan({ kind: SpanKind.SERVER, attributes: { 'http.method': 'GET', 'http.status_code': 200 } })
    );
    assert.strictEqual(attrs['http.method'], 'GET');
    assert.strictEqual(attrs['http.status_code'], 200);
    assert.strictEqual(typeof attrs['http.status_code'], 'number', 'legacy status code stays an int');
    assert.ok(!('http.request.method' in attrs), 'never re-homed to the current key');
    assert.ok(!('http.response.status_code' in attrs));
  });

  it('prefers current http keys and does not add the legacy ones', () => {
    const attrs = buildAttributes(
      fakeSpan({
        attributes: {
          'http.request.method': 'GET',
          'http.method': 'GET',
          'http.response.status_code': 200,
          'http.status_code': 200,
        },
      })
    );
    assert.strictEqual(attrs['http.request.method'], 'GET');
    assert.strictEqual(attrs['http.response.status_code'], 200);
    assert.ok(!('http.method' in attrs));
    assert.ok(!('http.status_code' in attrs));
  });

  it('passes legacy rpc.system through unchanged and prefers current rpc.system.name', () => {
    const legacyOnly = buildAttributes(fakeSpan({ attributes: { 'rpc.system': 'grpc' } }));
    assert.strictEqual(legacyOnly['rpc.system'], 'grpc');
    assert.ok(!('rpc.system.name' in legacyOnly));
    const both = buildAttributes(fakeSpan({ attributes: { 'rpc.system.name': 'grpc', 'rpc.system': 'grpc' } }));
    assert.strictEqual(both['rpc.system.name'], 'grpc');
    assert.ok(!('rpc.system' in both));
  });

  it('prefers the current db key and does not add the legacy one', () => {
    const attrs = buildAttributes(
      fakeSpan({ attributes: { 'db.system.name': 'postgresql', 'db.system': 'postgresql' } })
    );
    assert.strictEqual(attrs['db.system.name'], 'postgresql');
    // current key present -> legacy fallback not applied, but the legacy key is itself allowlisted?
    // no: db.system is NOT in the allowlist, so it must be absent.
    assert.ok(!('db.system' in attrs));
  });

  it('copies a named messaging destination', () => {
    const attrs = buildAttributes(
      fakeSpan({ kind: SpanKind.PRODUCER, attributes: { 'messaging.destination.name': 'orders' } })
    );
    assert.strictEqual(attrs['messaging.destination.name'], 'orders');
  });

  it('omits messaging destination when temporary or anonymous', () => {
    const temp = buildAttributes(
      fakeSpan({
        attributes: { 'messaging.destination.name': 't1', 'messaging.destination.temporary': true },
      })
    );
    assert.ok(!('messaging.destination.name' in temp));

    const anon = buildAttributes(
      fakeSpan({
        attributes: { 'messaging.destination.name': 'a1', 'messaging.destination.anonymous': true },
      })
    );
    assert.ok(!('messaging.destination.name' in anon));
  });

  it('copies messaging operation type and consumer group', () => {
    const attrs = buildAttributes(
      fakeSpan({
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'kafka',
          'messaging.operation.type': 'receive',
          'messaging.consumer.group.name': 'order-processors',
        },
      })
    );
    assert.strictEqual(attrs['messaging.operation.type'], 'receive');
    assert.strictEqual(attrs['messaging.consumer.group.name'], 'order-processors');
  });

  it('copies peer attributes and keeps server.port a number', () => {
    const attrs = buildAttributes(
      fakeSpan({
        kind: SpanKind.CLIENT,
        attributes: {
          'server.address': 'payments.example.com',
          'server.port': 8443,
          'network.peer.address': '10.0.0.1', // not allowlisted
        },
      })
    );
    assert.strictEqual(attrs['server.address'], 'payments.example.com');
    // server.port is an int per semconv, kept as a number dimension rather than a string.
    assert.strictEqual(attrs['server.port'], 8443);
    assert.strictEqual(typeof attrs['server.port'], 'number');
    assert.ok(!('network.peer.address' in attrs));
  });

  it('copies gen_ai attributes', () => {
    const attrs = buildAttributes(
      fakeSpan({
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.request.model': 'claude-sonnet-4',
          'gen_ai.provider.name': 'aws.bedrock',
          'gen_ai.operation.name': 'chat',
        },
      })
    );
    assert.strictEqual(attrs['gen_ai.request.model'], 'claude-sonnet-4');
    assert.strictEqual(attrs['gen_ai.provider.name'], 'aws.bedrock');
    assert.strictEqual(attrs['gen_ai.operation.name'], 'chat');
  });

  it('copies AWS resource-identity attributes and preserves the dynamodb table_names array', () => {
    const attrs = buildAttributes(
      fakeSpan({
        kind: SpanKind.CLIENT,
        attributes: {
          'aws.s3.bucket': 'my-bucket',
          'aws.dynamodb.table_names': ['orders', 'items'],
          'aws.lambda.invoked_arn': 'arn:aws:lambda:us-east-1:123:function:fn',
          'aws.sns.topic.arn': 'arn:aws:sns:us-east-1:123:topic',
          'aws.sqs.queue.url': 'https://sqs.us-east-1.amazonaws.com/123/queue',
        },
      })
    );
    assert.strictEqual(attrs['aws.s3.bucket'], 'my-bucket');
    // table_names stays a string array per semconv; copied through unchanged, not normalized to a scalar.
    assert.ok(Array.isArray(attrs['aws.dynamodb.table_names']));
    assert.deepStrictEqual(attrs['aws.dynamodb.table_names'], ['orders', 'items']);
    assert.strictEqual(attrs['aws.lambda.invoked_arn'], 'arn:aws:lambda:us-east-1:123:function:fn');
    assert.strictEqual(attrs['aws.sns.topic.arn'], 'arn:aws:sns:us-east-1:123:topic');
    assert.strictEqual(attrs['aws.sqs.queue.url'], 'https://sqs.us-east-1.amazonaws.com/123/queue');
  });

  it('copies faas attributes', () => {
    const attrs = buildAttributes(
      fakeSpan({
        kind: SpanKind.CLIENT,
        attributes: {
          'faas.invoked_name': 'my-function',
          'faas.invoked_provider': 'aws',
          'faas.invoked_region': 'us-east-1',
          'faas.trigger': 'http',
        },
      })
    );
    assert.strictEqual(attrs['faas.invoked_name'], 'my-function');
    assert.strictEqual(attrs['faas.invoked_provider'], 'aws');
    assert.strictEqual(attrs['faas.invoked_region'], 'us-east-1');
    assert.strictEqual(attrs['faas.trigger'], 'http');
  });

  it('does not copy non-allowlisted keys from the new families', () => {
    const attrs = buildAttributes(
      fakeSpan({
        kind: SpanKind.CLIENT,
        attributes: {
          'server.address': 'payments.example.com',
          'gen_ai.request.temperature': 0.7, // not allowlisted (high-cardinality)
          'aws.dynamodb.item_collection_metrics': 'x', // not allowlisted
        },
      })
    );
    assert.strictEqual(attrs['server.address'], 'payments.example.com');
    assert.ok(!('gen_ai.request.temperature' in attrs));
    assert.ok(!('aws.dynamodb.item_collection_metrics' in attrs));
  });
});
