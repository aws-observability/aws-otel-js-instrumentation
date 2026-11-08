// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Context, diag, propagation, SpanKind, trace } from '@opentelemetry/api';
import { ReadableSpan, Span, SpanLimits, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { GEN_AI_INFERENCE_OPERATIONS } from './gen-ai-nested-client-span-processor';
import { ATTR_GEN_AI_OPERATION_NAME } from './instrumentation/common/semconv';
import { getRegisteredBaggageScope } from './scoped-baggage-registration';

export { clearRegisteredBaggageScopes, registerBaggageScope } from './scoped-baggage-registration';

export const AWS_AGENT_LINEAGE = 'aws.agent.lineage';
export const INFERENCE_SCOPE = 'aws.inference';

function genAiInferenceOperation(span: ReadableSpan): string | undefined {
  if (span.kind !== SpanKind.CLIENT) {
    return undefined;
  }
  const operation = (span.attributes || {})[ATTR_GEN_AI_OPERATION_NAME];
  return typeof operation === 'string' && GEN_AI_INFERENCE_OPERATIONS.includes(operation) ? operation : undefined;
}

/** A CLIENT span for a GenAI inference operation (chat, text_completion, generate_content, embeddings). */
export function isGenAiInferenceSpan(span: ReadableSpan): boolean {
  return genAiInferenceOperation(span) !== undefined;
}

/** Baggage captured at span start, held until the span ends. */
interface PendingSpan {
  baggage: Map<string, string>;
  // Inference operations of CLIENT child spans that have ended.
  inferenceChildOperations: Set<string>;
}

/**
 * Copies selected baggage entries to span attributes, but only on spans that match a scope.
 *
 * Unlike the upstream BaggageSpanProcessor, which copies keys to every span at start, a scope's
 * predicate depends on attributes that instrumentations often set after the span starts (for example
 * `gen_ai.operation.name`). Baggage is captured in `onStart` from the parent context, because the context
 * active when the span ends may not hold the same baggage, and applied in `onEnd` once a scope matches.
 *
 * This processor must run after processors that change span kind in onEnd (VercelAISpanProcessor,
 * GenAINestedClientSpanProcessor), so it sees the final kind, and before the exporter processors, so
 * they see the new attribute. Pending state is held in WeakMaps keyed by the span, so spans that never
 * end do not retain it.
 *
 * The built-in `aws.inference` scope matches only the innermost span of nested CLIENT inference spans with
 * the same operation, such as a framework span wrapping the model SDK span. The processor tracks this
 * itself, so the result does not depend on GenAINestedClientSpanProcessor being installed.
 *
 * A key is only set when the span does not already have it, so a value set by the instrumentation wins.
 */
export class ScopedBaggageSpanProcessor implements SpanProcessor {
  private readonly _scopedKeys: ReadonlyMap<string, ReadonlySet<string>>;
  private readonly _warnedScopes: Set<string> = new Set();
  private readonly _pendingBySpan: WeakMap<object, PendingSpan> = new WeakMap();
  // Child span -> pending state of its parent, for children of spans with pending baggage.
  private readonly _parentPendingBySpan: WeakMap<object, PendingSpan> = new WeakMap();

  /**
   * @param scopedKeys Mapping of baggage key to scope names. The key is copied to a span that matches any
   * of its scopes. A scope can be built in or registered later with registerBaggageScope(). An unknown
   * scope matches no span.
   */
  constructor(scopedKeys: ReadonlyMap<string, Iterable<string>> | Record<string, string | Iterable<string>>) {
    const entries = scopedKeys instanceof Map ? [...scopedKeys] : Object.entries(scopedKeys);
    this._scopedKeys = new Map(
      entries.map(([key, scopes]) => [key, new Set(typeof scopes === 'string' ? [scopes] : scopes)])
    );
  }

  onStart(span: Span, parentContext: Context): void {
    const scopedKeys = this._scopedKeys;
    if (scopedKeys.size === 0) {
      return;
    }
    const parent = trace.getSpan(parentContext);
    const parentPending = parent && this._pendingBySpan.get(parent);
    if (parentPending) {
      this._parentPendingBySpan.set(span, parentPending);
    }
    const entries = propagation.getBaggage(parentContext)?.getAllEntries() ?? [];
    const baggage = new Map<string, string>();
    for (const [key, entry] of entries) {
      if (scopedKeys.has(key)) {
        baggage.set(key, entry.value);
      }
    }
    if (baggage.size > 0) {
      this._pendingBySpan.set(span, { baggage, inferenceChildOperations: new Set() });
    }
  }

  onEnd(span: ReadableSpan): void {
    const parentPending = this._parentPendingBySpan.get(span);
    if (parentPending) {
      this._parentPendingBySpan.delete(span);
      // Record this span on its parent, so a parent with the same operation does not match aws.inference.
      // Children end before their parents.
      const operation = genAiInferenceOperation(span);
      if (operation !== undefined) {
        parentPending.inferenceChildOperations.add(operation);
      }
    }
    const pending = this._pendingBySpan.get(span);
    if (!pending) {
      return;
    }
    this._pendingBySpan.delete(span);
    for (const [key, value] of pending.baggage) {
      const scopes = this._scopedKeys.get(key) ?? [];
      for (const scope of scopes) {
        if (this.scopeMatches(scope, span, pending)) {
          setAttributeIfAbsent(span, key, value);
          break;
        }
      }
    }
  }

  private scopeMatches(scopeName: string, span: ReadableSpan, pending: PendingSpan): boolean {
    if (scopeName === INFERENCE_SCOPE) {
      const operation = genAiInferenceOperation(span);
      return operation !== undefined && !pending.inferenceChildOperations.has(operation);
    }
    const predicate = getRegisteredBaggageScope(scopeName);
    if (!predicate) {
      this.warnUnknownScope(scopeName);
      return false;
    }
    try {
      return Boolean(predicate(span));
    } catch (e) {
      diag.debug(`Baggage scope '${scopeName}' check failed`, e);
      return false;
    }
  }

  private warnUnknownScope(scopeName: string): void {
    if (this._warnedScopes.has(scopeName)) {
      return;
    }
    this._warnedScopes.add(scopeName);
    diag.warn(`Unknown baggage scope '${scopeName}' in OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS. It matches no span.`);
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
  // An own-property check, so keys like 'constructor' are not mistaken for existing attributes.
  if (!attributes || Object.prototype.hasOwnProperty.call(attributes, key)) {
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
