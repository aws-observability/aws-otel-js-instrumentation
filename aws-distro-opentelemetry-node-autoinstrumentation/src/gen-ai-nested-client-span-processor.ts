// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Context, SpanKind, trace } from '@opentelemetry/api';
import { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
} from './instrumentation/common/semconv';

const GEN_AI_INFERENCE_OPERATIONS: readonly string[] = [
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
];

export class GenAINestedClientSpanProcessor implements SpanProcessor {
  // OTel GenAI semantic conventions require outgoing LLM calls to be CLIENT spans.
  // However, the same call can be instrumented by both the agentic framework
  // and the underlying LLM client SDK, producing nested CLIENT spans for a single request.
  // This processor converts the outer span to INTERNAL only when its child has
  // the same GenAI inference operation.
  //
  // State is kept only for local parents that are still open when a child starts, in WeakMaps keyed by
  // the span, so it is released when the span ends or is garbage-collected. A remote parent, or a parent
  // that has already ended, gets no state. Kind is not checked at start because processors can change it
  // in onEnd (VercelAISpanProcessor promotes INTERNAL spans to CLIENT).

  // Open local parent span -> inference operations of its ended CLIENT children.
  private _childOperationsByParent: WeakMap<object, Set<string>> = new WeakMap();
  // Child span -> its parent's set above, for children started under an open local parent.
  private _parentOperationsByChild: WeakMap<object, Set<string>> = new WeakMap();

  onStart(span: Span, parentContext: Context): void {
    const parent = trace.getSpan(parentContext);
    if (!parent || !parent.isRecording() || parent.spanContext().isRemote) {
      return;
    }
    let operations = this._childOperationsByParent.get(parent);
    if (!operations) {
      operations = new Set();
      this._childOperationsByParent.set(parent, operations);
    }
    this._parentOperationsByChild.set(span, operations);
  }

  onEnd(span: ReadableSpan): void {
    // Clean up before early returns so state cannot outlive the span.
    const childOperations = this._childOperationsByParent.get(span);
    this._childOperationsByParent.delete(span);
    const parentOperations = this._parentOperationsByChild.get(span);
    this._parentOperationsByChild.delete(span);

    if (span.kind !== SpanKind.CLIENT) {
      return;
    }

    const operation = (span.attributes || {})[ATTR_GEN_AI_OPERATION_NAME] as string | undefined;
    if (!operation || !GEN_AI_INFERENCE_OPERATIONS.includes(operation)) {
      return;
    }

    // If the parent already ended, this set is no longer reachable from the parent and is dropped with
    // this span.
    parentOperations?.add(operation);

    if (childOperations?.has(operation)) {
      (span as any).kind = SpanKind.INTERNAL;
    }
  }

  shutdown(): Promise<void> {
    this._childOperationsByParent = new WeakMap();
    this._parentOperationsByChild = new WeakMap();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
