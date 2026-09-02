// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Context, SpanKind } from '@opentelemetry/api';
import { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
} from './instrumentation/common/semconv';

const GEN_AI_INFERENCE_OPERATIONS: Set<string> = new Set([
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
]);

export class GenAiNestedClientSpanProcessor implements SpanProcessor {
  // OTel GenAI semantic conventions require outgoing LLM calls to be CLIENT spans.
  // However, the same call can be instrumented by both the agentic framework
  // and the underlying LLM client SDK, producing nested CLIENT spans for a single request.
  // This processor converts the outer span to INTERNAL only when its child has
  // the same GenAI inference operation.

  private _parentSpanIdToGenAiClientChildOperations: Map<string, Set<string>> = new Map();

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    // Clean up before early returns so child state cannot leak for non-GenAI parents.
    const spanId = span.spanContext().spanId;
    const childOperations = this._parentSpanIdToGenAiClientChildOperations.get(spanId);
    this._parentSpanIdToGenAiClientChildOperations.delete(spanId);

    if (span.kind !== SpanKind.CLIENT) {
      return;
    }

    const operationName = (span.attributes || {})[ATTR_GEN_AI_OPERATION_NAME] as string | undefined;
    if (!operationName || !GEN_AI_INFERENCE_OPERATIONS.has(operationName)) {
      return;
    }

    const parentSpanId = span.parentSpanContext?.spanId;
    if (parentSpanId) {
      const operations = this._parentSpanIdToGenAiClientChildOperations.get(parentSpanId) ?? new Set<string>();
      operations.add(operationName);
      this._parentSpanIdToGenAiClientChildOperations.set(parentSpanId, operations);
    }

    if (childOperations?.has(operationName)) {
      (span as any).kind = SpanKind.INTERNAL;
    }
  }

  shutdown(): Promise<void> {
    this._parentSpanIdToGenAiClientChildOperations.clear();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
