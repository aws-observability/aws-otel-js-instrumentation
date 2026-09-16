// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { LIB_VERSION, LIB_VERSION_ATTR, SCHEMA_ATTR, SCHEMA_VERSION } from './identity';

// Copied when present, regardless of span family (a span only carries the keys of its own family,
// so no family branching is needed). Value TYPES are preserved as the span carries them:
// http.response.status_code and server.port stay numbers (int semconv type), aws.dynamodb.table_names
// stays a string array, and everything else is a string. Values are copied through unchanged — no
// synthesis and no normalization. These are the current semconv keys; legacy predecessors are handled
// by LEGACY_FALLBACKS below.
const ALLOWLIST: string[] = [
  // HTTP (https://opentelemetry.io/docs/specs/semconv/http/http-metrics/)
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'error.type',
  // RPC (https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics/)
  'rpc.system.name',
  'rpc.service',
  'rpc.method',
  // Database (https://opentelemetry.io/docs/specs/semconv/db/database-metrics/)
  'db.system.name',
  'db.operation.name',
  'db.collection.name',
  // Messaging (https://opentelemetry.io/docs/specs/semconv/messaging/messaging-metrics/)
  'messaging.system',
  'messaging.operation.name',
  'messaging.operation.type',
  'messaging.consumer.group.name',
  // Peer (https://opentelemetry.io/docs/specs/semconv/registry/attributes/server/)
  'server.address',
  'server.port',
  // GenAI (https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/)
  'gen_ai.request.model',
  'gen_ai.provider.name',
  'gen_ai.operation.name',
  // AWS resource identity (https://opentelemetry.io/docs/specs/semconv/registry/attributes/aws/)
  'aws.s3.bucket',
  'aws.dynamodb.table_names',
  'aws.lambda.invoked_arn',
  'aws.sns.topic.arn',
  'aws.sqs.queue.url',
  // FaaS (https://opentelemetry.io/docs/specs/semconv/registry/attributes/faas/)
  'faas.invoked_name',
  'faas.invoked_provider',
  'faas.invoked_region',
  'faas.trigger',
];

// Current semconv key -> legacy keys, checked when the current key is absent (spec §4). Each entry
// lists its legacy predecessors in first-present-wins order. When only a legacy key is present it is
// passed through under its own key/value, unchanged — never re-homed to the current key, because some
// migrations also changed the value vocabulary. The peer keys have two legacy spellings: net.peer.*
// (client spans) and net.host.* (server spans), per the server semconv
// (https://opentelemetry.io/docs/specs/semconv/registry/attributes/server/).
const LEGACY_FALLBACKS: Array<{ currentKey: string; legacyKeys: string[] }> = [
  { currentKey: 'http.request.method', legacyKeys: ['http.method'] },
  { currentKey: 'http.response.status_code', legacyKeys: ['http.status_code'] },
  { currentKey: 'rpc.system.name', legacyKeys: ['rpc.system'] },
  { currentKey: 'db.system.name', legacyKeys: ['db.system'] },
  { currentKey: 'db.operation.name', legacyKeys: ['db.operation'] },
  { currentKey: 'db.collection.name', legacyKeys: ['db.sql.table'] },
  { currentKey: 'server.address', legacyKeys: ['net.peer.name', 'net.host.name'] },
  { currentKey: 'server.port', legacyKeys: ['net.peer.port', 'net.host.port'] },
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
  for (const { currentKey, legacyKeys } of LEGACY_FALLBACKS) {
    if (source[currentKey] !== undefined) {
      continue;
    }
    // First present legacy key wins; its value is passed through unchanged.
    for (const legacyKey of legacyKeys) {
      const legacyValue = source[legacyKey];
      if (legacyValue !== undefined) {
        out[legacyKey] = legacyValue;
        break;
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
