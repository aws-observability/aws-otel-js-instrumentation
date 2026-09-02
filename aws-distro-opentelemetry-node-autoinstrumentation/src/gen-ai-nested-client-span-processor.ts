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

export class GenAINestedClientSpanProcessor implements SpanProcessor {
  // OTel GenAI semantic conventions require outgoing LLM calls to be CLIENT spans.
  // However, the same call can be instrumented by both the agentic framework
  // and the underlying LLM client SDK, producing nested CLIENT spans for a single request.
  // This processor converts the outer span to INTERNAL only when its child has
  // the same GenAI inference operation.

  // Tracks which parent spans have a GenAI CLIENT child for each operation.
  private _parentSpanIdAndOperationToGenAiClientChild: Map<string, boolean> = new Map();

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    const genAiInferenceOperations = [
      GEN_AI_OPERATION_NAME_VALUE_CHAT,
      GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
      GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
      GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
    ];

    // Clean up before early returns so child state cannot leak for non-GenAI parents.
    const spanId = span.spanContext().spanId;
    const childOperations = new Set(
      genAiInferenceOperations.filter(
        operation => spanId && this._parentSpanIdAndOperationToGenAiClientChild.delete(`${spanId}:${operation}`)
      )
    );

    if (span.kind !== SpanKind.CLIENT) {
      return;
    }

    const operation = (span.attributes || {})[ATTR_GEN_AI_OPERATION_NAME] as string | undefined;
    if (!operation || !genAiInferenceOperations.includes(operation)) {
      return;
    }

    const parentSpanId = span.parentSpanContext?.spanId;
    if (parentSpanId) {
      this._parentSpanIdAndOperationToGenAiClientChild.set(`${parentSpanId}:${operation}`, true);
    }

    if (childOperations.has(operation)) {
      (span as any).kind = SpanKind.INTERNAL;
    }
  }

  shutdown(): Promise<void> {
    this._parentSpanIdAndOperationToGenAiClientChild.clear();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
