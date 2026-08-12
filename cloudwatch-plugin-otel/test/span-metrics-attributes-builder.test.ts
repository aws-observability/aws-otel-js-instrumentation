// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import * as assert from 'assert';
import { buildAttributes } from '../src/span-metrics-attributes-builder';
import { LIB_VERSION } from '../src/identity';
import { fakeSpan } from './test-utils';

describe('SpanMetricsAttributesBuilder', () => {
  it('emits the four base dimensions in short form plus schema/lib markers', () => {
    const attrs = buildAttributes(
      fakeSpan({ name: 'GET /x', kind: SpanKind.CLIENT, statusCode: SpanStatusCode.ERROR })
    );
    assert.strictEqual(attrs['span.name'], 'GET /x');
    assert.strictEqual(attrs['span.kind'], 'CLIENT');
    assert.strictEqual(attrs['status.code'], 'ERROR');
    assert.strictEqual(attrs['service.name'], 'svc');
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

  it('omits service.name when the resource has none', () => {
    const attrs = buildAttributes(fakeSpan({ resourceAttributes: {} }));
    assert.ok(!('service.name' in attrs));
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
    assert.strictEqual(attrs['rpc.system'], 'grpc');
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
});
