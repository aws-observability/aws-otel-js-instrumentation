// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Context, diag, propagation, SpanKind } from '@opentelemetry/api';
import { ReadableSpan, Span, SpanLimits, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { GEN_AI_INFERENCE_OPERATIONS } from './gen-ai-nested-client-span-processor';
import { ATTR_GEN_AI_OPERATION_NAME } from './instrumentation/common/semconv';

export const AWS_AGENT_LINEAGE = 'aws.agent.lineage';
export const INFERENCE_SCOPE = 'inference';

/** A CLIENT span for a GenAI inference operation (chat, text_completion, generate_content, embeddings). */
export function isGenAiInferenceSpan(span: ReadableSpan): boolean {
  if (span.kind !== SpanKind.CLIENT) {
    return false;
  }
  const operation = (span.attributes || {})[ATTR_GEN_AI_OPERATION_NAME];
  return typeof operation === 'string' && GEN_AI_INFERENCE_OPERATIONS.includes(operation);
}

// Internal scope registry: scope name -> predicate evaluated when the span ends. Predicates run only at
// end because processors can change a span's kind and attributes in onEnd. For example,
// VercelAISpanProcessor promotes inference spans from INTERNAL to CLIENT.
const SCOPES: Record<string, (span: ReadableSpan) => boolean> = {
  [INFERENCE_SCOPE]: isGenAiInferenceSpan,
};

/**
 * Copies selected baggage entries to span attributes, but only on spans that match a scope.
 *
 * Unlike the upstream BaggageSpanProcessor, which copies keys to every span at start, a scope's
 * predicate depends on attributes that instrumentations often set after the span starts (for example
 * `gen_ai.operation.name`). Baggage is captured in `onStart` from the parent context, because the context
 * active when the span ends may not hold the same baggage, and applied in `onEnd` once the scope matches.
 *
 * This processor must run after processors that change span kind in onEnd (VercelAISpanProcessor,
 * GenAINestedClientSpanProcessor), so it sees the final kind, and before the exporter processors, so
 * they see the new attribute. Pending baggage is held in a WeakMap keyed by the span, so spans that
 * never end do not retain it.
 *
 * A key is only set when the span does not already have it, so a value set by the instrumentation wins.
 */
export class ScopedBaggageSpanProcessor implements SpanProcessor {
  private readonly _scopedKeys: Map<string, (span: ReadableSpan) => boolean> = new Map();
  private readonly _pendingBySpan: WeakMap<object, Record<string, string>> = new WeakMap();

  /**
   * @param scopedKeys Mapping of baggage key to scope name. Keys with unknown scopes are ignored.
   */
  constructor(scopedKeys: Record<string, string>) {
    for (const [key, scope] of Object.entries(scopedKeys)) {
      const predicate = SCOPES[scope];
      if (!predicate) {
        diag.warn(`Unknown baggage scope '${scope}' for key '${key}'. The key will not be copied.`);
        continue;
      }
      this._scopedKeys.set(key, predicate);
    }
  }

  onStart(span: Span, parentContext: Context): void {
    if (this._scopedKeys.size === 0) {
      return;
    }
    const entries = propagation.getBaggage(parentContext)?.getAllEntries() ?? [];
    const pending: Record<string, string> = {};
    let found = false;
    for (const [key, entry] of entries) {
      if (this._scopedKeys.has(key)) {
        pending[key] = entry.value;
        found = true;
      }
    }
    if (found) {
      this._pendingBySpan.set(span, pending);
    }
  }

  onEnd(span: ReadableSpan): void {
    const pending = this._pendingBySpan.get(span);
    if (!pending) {
      return;
    }
    this._pendingBySpan.delete(span);
    for (const [key, value] of Object.entries(pending)) {
      const predicate = this._scopedKeys.get(key);
      if (!predicate) {
        continue;
      }
      let matches = false;
      try {
        matches = predicate(span);
      } catch (e) {
        diag.debug(`Baggage scope check failed for key '${key}'`, e);
        continue;
      }
      if (matches) {
        setAttributeIfAbsent(span, key, value);
      }
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// Private fields of the SDK Span used to respect attribute limits after the span has ended.
interface SdkSpanInternals {
  _spanLimits?: SpanLimits;
  _droppedAttributesCount?: number;
}

function setAttributeIfAbsent(span: ReadableSpan, key: string, value: string): void {
  // The span has ended, so setAttribute() is a no-op. Write the attributes object directly, as
  // AttributeRedactingSpanProcessor does, and respect the span's attribute limits. When the span is
  // full, skip the key rather than evict an attribute the instrumentation set.
  const attributes = span.attributes as Record<string, unknown>;
  if (!attributes || key in attributes) {
    return;
  }
  const internals = span as unknown as SdkSpanInternals;
  const limits = internals._spanLimits;
  const countLimit = limits?.attributeCountLimit;
  if (countLimit !== undefined && Object.keys(attributes).length >= countLimit) {
    if (typeof internals._droppedAttributesCount === 'number') {
      internals._droppedAttributesCount++;
    }
    return;
  }
  const lengthLimit = limits?.attributeValueLengthLimit;
  attributes[key] =
    lengthLimit !== undefined && lengthLimit > 0 && value.length > lengthLimit ? value.slice(0, lengthLimit) : value;
}
