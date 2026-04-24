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

export class GenAiNestedClientSpanProcessor implements SpanProcessor {
  // OTel GenAI semantic conventions require outgoing LLM calls to be CLIENT spans.
  // However, the same call can be instrumented by both the agentic framework
  // and the underlying LLM client SDK, producing nested CLIENT spans for a single request.
  // This processor converts the outer span to INTERNAL so only the innermost
  // SDK span remains CLIENT, avoiding the nested CLIENT anti-pattern.

  private _hasGenAiClientChild: Map<string, boolean> = new Map();

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (span.kind !== SpanKind.CLIENT) {
      return;
    }

    const parentSpanId = span.parentSpanContext?.spanId;
    if (parentSpanId) {
      this._hasGenAiClientChild.set(parentSpanId, true);
    }

    const operationName = (span.attributes || {})[ATTR_GEN_AI_OPERATION_NAME] as string | undefined;
    const isLlmSpan =
      operationName === GEN_AI_OPERATION_NAME_VALUE_CHAT ||
      operationName === GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION ||
      operationName === GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT ||
      operationName === GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS;

    if (isLlmSpan && span.spanContext() && this._hasGenAiClientChild.delete(span.spanContext().spanId)) {
      (span as any).kind = SpanKind.INTERNAL;
    }
  }

  shutdown(): Promise<void> {
    this._hasGenAiClientChild.clear();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
