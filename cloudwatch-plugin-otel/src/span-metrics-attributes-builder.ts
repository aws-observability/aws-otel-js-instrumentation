// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { LIB_VERSION, LIB_VERSION_ATTR, SCHEMA_ATTR, SCHEMA_VERSION } from './identity';

// Copied when present, regardless of span family (a span only carries the keys of its own family,
// so no family branching is needed). Value TYPES are preserved as the span carries them:
// http.response.status_code stays a number per semconv; everything else is a string.
const ALLOWLIST: string[] = [
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'error.type',
  'rpc.system',
  'rpc.service',
  'rpc.method',
  'db.system.name',
  'db.operation.name',
  'db.collection.name',
  'messaging.system',
  'messaging.operation.name',
];

// Current semconv key -> legacy key, checked when the current key is absent (spec §4). When only the
// legacy key is present it is passed through under its own key/value, unchanged — never re-homed to
// the current key, because some migrations also changed the value vocabulary.
const LEGACY_FALLBACKS: Array<{ currentKey: string; legacyKey: string }> = [
  { currentKey: 'db.system.name', legacyKey: 'db.system' },
  { currentKey: 'db.operation.name', legacyKey: 'db.operation' },
  { currentKey: 'db.collection.name', legacyKey: 'db.sql.table' },
];

const MESSAGING_DESTINATION_NAME = 'messaging.destination.name';
const MESSAGING_DESTINATION_TEMPORARY = 'messaging.destination.temporary';
const MESSAGING_DESTINATION_ANONYMOUS = 'messaging.destination.anonymous';

const SPAN_KIND_NAMES: Record<SpanKind, string> = {
  [SpanKind.INTERNAL]: 'INTERNAL',
  [SpanKind.SERVER]: 'SERVER',
  [SpanKind.CLIENT]: 'CLIENT',
  [SpanKind.PRODUCER]: 'PRODUCER',
  [SpanKind.CONSUMER]: 'CONSUMER',
};

const STATUS_CODE_NAMES: Record<SpanStatusCode, string> = {
  [SpanStatusCode.UNSET]: 'UNSET',
  [SpanStatusCode.OK]: 'OK',
  [SpanStatusCode.ERROR]: 'ERROR',
};

// Builds the metric attribute set: the base dimensions, any allowlisted semconv attribute present
// on the span, and the identity/schema markers. service.name is deliberately NOT a datapoint
// attribute: the metric's resource already carries it (the extension records into the host SDK's
// MeterProvider, whose resource includes service.name), so duplicating it per-datapoint would add a
// redundant dimension. Consumers read service.name from the resource.
export function buildAttributes(span: ReadableSpan): Attributes {
  const attributes: Attributes = {
    'span.name': span.name,
    'span.kind': SPAN_KIND_NAMES[span.kind] ?? 'INTERNAL',
    'status.code': STATUS_CODE_NAMES[span.status.code] ?? 'UNSET',
    // Schema + library-version markers appear on both spans and metrics.
    [SCHEMA_ATTR]: SCHEMA_VERSION,
    [LIB_VERSION_ATTR]: LIB_VERSION,
  };

  const spanAttributes = span.attributes;
  for (const key of ALLOWLIST) {
    const value = spanAttributes[key];
    if (value !== undefined) {
      attributes[key] = value;
    }
  }
  applyLegacyFallbacks(attributes, spanAttributes);
  copyDestinationIfNamed(attributes, spanAttributes);
  return attributes;
}

function applyLegacyFallbacks(out: Attributes, source: Attributes): void {
  for (const { currentKey, legacyKey } of LEGACY_FALLBACKS) {
    if (source[currentKey] === undefined) {
      const legacyValue = source[legacyKey];
      if (legacyValue !== undefined) {
        out[legacyKey] = legacyValue;
      }
    }
  }
}

// Messaging destinations that are temporary or anonymous have unbounded names; omit them.
function copyDestinationIfNamed(out: Attributes, source: Attributes): void {
  const destination = source[MESSAGING_DESTINATION_NAME];
  if (destination === undefined) {
    return;
  }
  if (source[MESSAGING_DESTINATION_TEMPORARY] === true || source[MESSAGING_DESTINATION_ANONYMOUS] === true) {
    return;
  }
  out[MESSAGING_DESTINATION_NAME] = destination;
}
