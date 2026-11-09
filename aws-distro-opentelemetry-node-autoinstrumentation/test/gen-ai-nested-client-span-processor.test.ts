// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, ROOT_CONTEXT, SpanKind, TraceFlags, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { spawnSync } from 'child_process';
import { expect } from 'expect';
import { GenAINestedClientSpanProcessor } from '../src/gen-ai-nested-client-span-processor';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
} from '../src/instrumentation/common/semconv';

describe('TestGenAINestedClientSpanProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let processor: GenAINestedClientSpanProcessor;
  let tracer: ReturnType<NodeTracerProvider['getTracer']>;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    processor = new GenAINestedClientSpanProcessor();
    provider = new NodeTracerProvider({
      spanProcessors: [processor, new SimpleSpanProcessor(exporter)],
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

  it('should keep parent CLIENT when HTTP child span exists', () => {
    const parent = makeLlmSpan();
    const ctx = trace.setSpan(context.active(), parent);
    const child = tracer.startSpan('POST', { kind: SpanKind.CLIENT }, ctx);
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    const parentSpan = spans.find(s => s.name === 'chat model')!;
    expect(parentSpan.kind).toBe(SpanKind.CLIENT);
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

  it('should keep parent CLIENT when nested GenAI child has a different operation', () => {
    const parent = makeLlmSpan();
    const ctx = trace.setSpan(context.active(), parent);
    const child = makeLlmSpan('embeddings model', GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS, SpanKind.CLIENT, ctx);
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
    expect(spans[1].kind).toBe(SpanKind.CLIENT);
    expect((processor as any)._childOperationsByParent.has(parent)).toBe(false);
  });

  it('should not convert non-LLM operation', () => {
    const span = tracer.startSpan('invoke_agent MyAgent', { kind: SpanKind.CLIENT });
    span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
  });

  it('should keep a non-LLM parent CLIENT when it has a nested GenAI child', () => {
    const parent = tracer.startSpan('invoke_agent MyAgent', { kind: SpanKind.CLIENT });
    parent.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
    const ctx = trace.setSpan(context.active(), parent);
    const child = makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_CHAT, SpanKind.CLIENT, ctx);
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].kind).toBe(SpanKind.CLIENT);
    expect(spans[1].kind).toBe(SpanKind.CLIENT);
    expect((processor as any)._childOperationsByParent.has(parent)).toBe(false);
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

  it('should demote all but the innermost of three nested spans', () => {
    const top = makeLlmSpan('top');
    const middle = makeLlmSpan(
      'middle',
      GEN_AI_OPERATION_NAME_VALUE_CHAT,
      SpanKind.CLIENT,
      trace.setSpan(ROOT_CONTEXT, top)
    );
    const inner = makeLlmSpan(
      'inner',
      GEN_AI_OPERATION_NAME_VALUE_CHAT,
      SpanKind.CLIENT,
      trace.setSpan(ROOT_CONTEXT, middle)
    );
    inner.end();
    middle.end();
    top.end();

    const kinds = Object.fromEntries(exporter.getFinishedSpans().map(span => [span.name, span.kind]));
    expect(kinds).toEqual({ top: SpanKind.INTERNAL, middle: SpanKind.INTERNAL, inner: SpanKind.CLIENT });
  });

  it('should keep no state for a remote parent', () => {
    const remote = trace.wrapSpanContext({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    const child = makeLlmSpan(
      'chat model',
      GEN_AI_OPERATION_NAME_VALUE_CHAT,
      SpanKind.CLIENT,
      trace.setSpan(ROOT_CONTEXT, remote)
    );
    expect((processor as any)._parentOperationsByChild.has(child)).toBe(false);
    child.end();

    expect((processor as any)._childOperationsByParent.has(remote)).toBe(false);
  });

  it('should not recreate state for a parent that ended before its child', () => {
    const parent = tracer.startSpan('agent');
    const ctx = trace.setSpan(ROOT_CONTEXT, parent);
    const child = makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_CHAT, SpanKind.CLIENT, ctx);
    parent.end();
    child.end();
    // A child that starts after its parent ended.
    const late = makeLlmSpan('late', GEN_AI_OPERATION_NAME_VALUE_CHAT, SpanKind.CLIENT, ctx);
    expect((processor as any)._parentOperationsByChild.has(late)).toBe(false);
    late.end();

    expect((processor as any)._childOperationsByParent.has(parent)).toBe(false);
  });

  it('should let parents be garbage-collected while their children are open', () => {
    // Runs in a child process for --expose-gc. Uses the compiled processor directly.
    // Compares against a provider without the processor, because the runtime can keep the most recently
    // created span reachable on its own.
    const script = `
      const path = require('path');
      const { trace, ROOT_CONTEXT, SpanKind } = require('@opentelemetry/api');
      const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
      const { AlwaysOnSampler } = require('@opentelemetry/sdk-trace-base');
      const { GenAINestedClientSpanProcessor } = require(
        path.join(process.cwd(), '..', 'build', 'src', 'gen-ai-nested-client-span-processor')
      );
      async function aliveParents(spanProcessors) {
        const tracer = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors }).getTracer('t');
        const parents = [];
        const children = [];
        function startPair() {
          const parent = tracer.startSpan('agent');
          parents.push(new WeakRef(parent));
          const child = tracer.startSpan('chat', { kind: SpanKind.CLIENT }, trace.setSpan(ROOT_CONTEXT, parent));
          child.setAttribute('gen_ai.operation.name', 'chat');
          children.push(child);
        }
        for (let i = 0; i < 1000; i++) startPair();
        for (let i = 0; i < 20; i++) {
          global.gc();
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const alive = parents.filter(ref => ref.deref()).length;
        children.forEach(child => child.end());
        return alive;
      }
      (async () => {
        const baseline = await aliveParents([]);
        const alive = await aliveParents([new GenAINestedClientSpanProcessor()]);
        process.exit(alive <= baseline && baseline <= 1 ? 0 : 1);
      })();
    `;
    const proc = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
      cwd: __dirname,
      timeout: 20000,
      killSignal: 'SIGKILL',
    });
    expect(proc.error).toBeUndefined();
    expect(proc.status).toBe(0);
  });

  it('should clear state on shutdown', async () => {
    const parent = tracer.startSpan('agent');
    makeLlmSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_CHAT, SpanKind.CLIENT, trace.setSpan(ROOT_CONTEXT, parent));
    expect((processor as any)._childOperationsByParent.has(parent)).toBe(true);
    await processor.shutdown();
    expect((processor as any)._childOperationsByParent.has(parent)).toBe(false);
  });

  it('should return resolved promise from forceFlush', async () => {
    const processor = new GenAINestedClientSpanProcessor();
    await processor.forceFlush();
  });
});
