// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, SpanKind, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { expect } from 'expect';
import { GenAiNestedClientSpanProcessor } from '../src/gen-ai-nested-client-span-processor';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
} from '../src/instrumentation/common/semconv';

describe('TestGenAiNestedClientSpanProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let tracer: ReturnType<NodeTracerProvider['getTracer']>;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new GenAiNestedClientSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    tracer = provider.getTracer('test');
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  function makeLlmSpan(
    name: string = 'chat model',
    op: string = GEN_AI_OPERATION_NAME_VALUE_CHAT,
    kind: SpanKind = SpanKind.CLIENT,
    ctx?: ReturnType<typeof context.active>
  ) {
    const span = tracer.startSpan(name, { kind }, ctx);
    span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, op);
    return span;
  }

  it('should convert parent to INTERNAL when nested LLM CLIENT child exists', () => {
    const parent = makeLlmSpan();
    const ctx = trace.setSpan(context.active(), parent);
    const child = makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_CHAT, SpanKind.CLIENT, ctx);
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    const childSpan = spans[0];
    const parentSpan = spans[1];
    expect(childSpan.kind).toBe(SpanKind.CLIENT);
    expect(parentSpan.kind).toBe(SpanKind.INTERNAL);
  });

  it('should convert parent when HTTP child span exists', () => {
    const parent = makeLlmSpan();
    const ctx = trace.setSpan(context.active(), parent);
    const child = tracer.startSpan('POST', { kind: SpanKind.CLIENT }, ctx);
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    const parentSpan = spans.find(s => s.name === 'chat model')!;
    expect(parentSpan.kind).toBe(SpanKind.INTERNAL);
  });

  it('should keep CLIENT when no child exists', () => {
    const span = makeLlmSpan();
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
  });

  it('should convert text_completion parent by child', () => {
    const parent = makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION);
    const ctx = trace.setSpan(context.active(), parent);
    const child = makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION, SpanKind.CLIENT, ctx);
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
    expect(spans[1].kind).toBe(SpanKind.INTERNAL);
  });

  it('should convert embeddings parent by child', () => {
    const parent = makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS);
    const ctx = trace.setSpan(context.active(), parent);
    const child = makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS, SpanKind.CLIENT, ctx);
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
    expect(spans[1].kind).toBe(SpanKind.INTERNAL);
  });

  it('should convert generate_content parent by child', () => {
    const parent = makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT);
    const ctx = trace.setSpan(context.active(), parent);
    const child = makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT, SpanKind.CLIENT, ctx);
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
    expect(spans[1].kind).toBe(SpanKind.INTERNAL);
  });

  it('should not convert non-LLM operation', () => {
    const span = tracer.startSpan('invoke_agent MyAgent', { kind: SpanKind.CLIENT });
    span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
  });

  it('should not modify INTERNAL span', () => {
    const span = tracer.startSpan('chat model', { kind: SpanKind.INTERNAL });
    span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.INTERNAL);
  });

  it('should not modify span without gen_ai attribute', () => {
    const span = tracer.startSpan('some-span', { kind: SpanKind.CLIENT });
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
  });

  it('should keep CLIENT when no parent', () => {
    const span = makeLlmSpan();
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
  });

  it('should clear state on shutdown', async () => {
    const processor = new GenAiNestedClientSpanProcessor();
    (processor as any)._hasGenAiClientChild.set('123', true);
    expect((processor as any)._hasGenAiClientChild.size).toBe(1);
    await processor.shutdown();
    expect((processor as any)._hasGenAiClientChild.size).toBe(0);
  });

  it('should return resolved promise from forceFlush', async () => {
    const processor = new GenAiNestedClientSpanProcessor();
    await processor.forceFlush();
  });
});
