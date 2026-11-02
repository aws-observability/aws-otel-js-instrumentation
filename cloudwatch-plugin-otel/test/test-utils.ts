// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, HrTime, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

// Builds a minimal ReadableSpan with the fields the attributes builder and processor read.
// Duration defaults to 5ms so tests can assert the 0.005s duration datapoint.
export function fakeSpan(opts: {
  name?: string;
  kind?: SpanKind;
  statusCode?: SpanStatusCode;
  attributes?: Attributes;
  resourceAttributes?: Attributes;
  durationSeconds?: number;
}): ReadableSpan {
  const durationSeconds = opts.durationSeconds ?? 0.005;
  const wholeSeconds = Math.floor(durationSeconds);
  const nanos = Math.round((durationSeconds - wholeSeconds) * 1e9);
  const duration: HrTime = [wholeSeconds, nanos];
  return {
    name: opts.name ?? 'op',
    kind: opts.kind ?? SpanKind.SERVER,
    status: { code: opts.statusCode ?? SpanStatusCode.UNSET },
    attributes: opts.attributes ?? {},
    resource: resourceFromAttributes(opts.resourceAttributes ?? { 'service.name': 'svc' }),
    duration,
    // Fields present on ReadableSpan but unused by the extension; typed loosely for the fake.
  } as unknown as ReadableSpan;
}
