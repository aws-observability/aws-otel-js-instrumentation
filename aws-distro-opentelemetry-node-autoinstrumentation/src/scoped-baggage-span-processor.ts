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

// The processor installed by the distro configurator, used by registerScopedBaggageKey(). It is kept on
// a global symbol so a second copy of this module (for example, one bundled by the application) finds it.
const ACTIVE_PROCESSOR_KEY = Symbol.for('aws.adot.scopedBaggageSpanProcessor');

export function setActiveScopedBaggageSpanProcessor(processor: ScopedBaggageSpanProcessor | undefined): void {
  (globalThis as Record<symbol, unknown>)[ACTIVE_PROCESSOR_KEY] = processor;
}

/**
 * Copy baggage entry `key` to spans that match `scope`. Not part of the documented API.
 *
 * Call it from application code after the distro has started. `scope` is a built-in scope name (for
 * example `'inference'`) or a predicate that receives the ending span and returns true to copy the key.
 * A predicate runs synchronously at the end of every span that carries the key, so it must be fast and
 * must not modify the span. If it throws, the key is not copied to that span.
 *
 * A key that is also listed in OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS is already copied to every span at start,
 * and that value is kept.
 *
 * @returns false, without registering, when agent observability is not enabled or the scope is unknown.
 */
export function registerScopedBaggageKey(key: string, scope: string | ((span: ReadableSpan) => boolean)): boolean {
  const processor = (globalThis as Record<symbol, unknown>)[ACTIVE_PROCESSOR_KEY] as
    | ScopedBaggageSpanProcessor
    | undefined;
  if (!processor) {
    diag.warn(
      `Cannot register scoped baggage key '${key}': the scoped baggage processor is installed only when ` +
        'AGENT_OBSERVABILITY_ENABLED=true.'
    );
    return false;
  }
  return processor.register(key, scope);
}

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
  private _scopedKeys: Map<string, (span: ReadableSpan) => boolean> = new Map();
  private readonly _pendingBySpan: WeakMap<object, Record<string, string>> = new WeakMap();

  /**
   * @param scopedKeys Mapping of baggage key to scope name. Keys with unknown scopes are ignored.
   */
  constructor(scopedKeys: Record<string, string>) {
    for (const [key, scope] of Object.entries(scopedKeys)) {
      this.register(key, scope);
    }
  }

  /** Copy baggage entry `key` to spans that match `scope`, a built-in scope name or a predicate. */
  register(key: string, scope: string | ((span: ReadableSpan) => boolean)): boolean {
    const predicate = typeof scope === 'string' ? SCOPES[scope] : scope;
    if (typeof predicate !== 'function') {
      diag.warn(`Unknown baggage scope '${scope}' for key '${key}'. The key will not be copied.`);
      return false;
    }
    // Replace the map so a registration never changes it while a span is being processed.
    const scopedKeys = new Map(this._scopedKeys);
    scopedKeys.set(key, predicate);
    this._scopedKeys = scopedKeys;
    return true;
  }

  onStart(span: Span, parentContext: Context): void {
    const scopedKeys = this._scopedKeys;
    if (scopedKeys.size === 0) {
      return;
    }
    const entries = propagation.getBaggage(parentContext)?.getAllEntries() ?? [];
    const pending: Record<string, string> = {};
    let found = false;
    for (const [key, entry] of entries) {
      if (scopedKeys.has(key)) {
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
