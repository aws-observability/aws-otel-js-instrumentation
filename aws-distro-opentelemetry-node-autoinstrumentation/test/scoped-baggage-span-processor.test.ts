// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, Context, ROOT_CONTEXT, propagation, SpanKind, trace } from '@opentelemetry/api';
import { BaggageSpanProcessor } from '@opentelemetry/baggage-span-processor';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { AlwaysOnSampler, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { GenAINestedClientSpanProcessor } from '../src/gen-ai-nested-client-span-processor';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
} from '../src/instrumentation/common/semconv';
import {
  AWS_AGENT_LINEAGE,
  INFERENCE_SCOPE,
  isGenAiInferenceSpan,
  ScopedBaggageSpanProcessor,
} from '../src/scoped-baggage-span-processor';

const LINEAGE = 'travel_planner,booking_agent';

function contextWithBaggage(entries: Record<string, string>, parent: Context = ROOT_CONTEXT): Context {
  const baggage = propagation.createBaggage(
    Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { value }]))
  );
  return propagation.setBaggage(parent, baggage);
}

describe('ScopedBaggageSpanProcessor', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let tracer: ReturnType<NodeTracerProvider['getTracer']>;
  const lineageContext = contextWithBaggage({ [AWS_AGENT_LINEAGE]: LINEAGE });

  function setup(
    processors: SpanProcessor[],
    spanLimits?: { attributeCountLimit?: number; attributeValueLengthLimit?: number }
  ) {
    exporter = new InMemorySpanExporter();
    // Explicit sampler so a sampler env var left by another test cannot make spans non-recording.
    provider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [...processors, new SimpleSpanProcessor(exporter)],
      spanLimits,
    });
    tracer = provider.getTracer('test');
  }

  function startSpan(
    name: string = 'chat model',
    op: string | null = GEN_AI_OPERATION_NAME_VALUE_CHAT,
    kind: SpanKind = SpanKind.CLIENT,
    ctx: Context = lineageContext
  ) {
    const span = tracer.startSpan(name, { kind }, ctx);
    if (op !== null) {
      span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, op);
    }
    return span;
  }

  function finished(name: string) {
    return exporter.getFinishedSpans().find(span => span.name === name)!;
  }

  beforeEach(() => {
    setup([new ScopedBaggageSpanProcessor({ [AWS_AGENT_LINEAGE]: INFERENCE_SCOPE })]);
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it('copies the key to CLIENT inference spans', () => {
    for (const op of [
      GEN_AI_OPERATION_NAME_VALUE_CHAT,
      GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
      GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
      GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
    ]) {
      startSpan(op, op).end();
      expect(finished(op).attributes[AWS_AGENT_LINEAGE]).toBe(LINEAGE);
    }
  });

  it('does not copy the key to non-inference spans', () => {
    startSpan('internal chat', GEN_AI_OPERATION_NAME_VALUE_CHAT, SpanKind.INTERNAL).end();
    startSpan('tool', 'execute_tool').end();
    startSpan('http', null).end();

    for (const name of ['internal chat', 'tool', 'http']) {
      expect(finished(name).attributes[AWS_AGENT_LINEAGE]).toBeUndefined();
    }
  });

  it('matches when gen_ai.operation.name is set after the span starts', () => {
    const span = tracer.startSpan('chat model', { kind: SpanKind.CLIENT }, lineageContext);
    span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
    span.end();

    expect(finished('chat model').attributes[AWS_AGENT_LINEAGE]).toBe(LINEAGE);
  });

  it('does not overwrite a value set by the instrumentation', () => {
    const span = startSpan();
    span.setAttribute(AWS_AGENT_LINEAGE, 'set_by_instrumentation');
    span.end();

    expect(finished('chat model').attributes[AWS_AGENT_LINEAGE]).toBe('set_by_instrumentation');
  });

  it('does nothing when the baggage has no matching key', () => {
    startSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_CHAT, SpanKind.CLIENT, ROOT_CONTEXT).end();

    expect(finished('chat model').attributes[AWS_AGENT_LINEAGE]).toBeUndefined();
  });

  it('skips the key when the span is full, without evicting attributes', async () => {
    await provider.shutdown();
    setup([new ScopedBaggageSpanProcessor({ [AWS_AGENT_LINEAGE]: INFERENCE_SCOPE })], { attributeCountLimit: 1 });

    startSpan().end();

    const span = finished('chat model');
    expect(span.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe(GEN_AI_OPERATION_NAME_VALUE_CHAT);
    expect(span.attributes[AWS_AGENT_LINEAGE]).toBeUndefined();
    expect(span.droppedAttributesCount).toBe(1);
  });

  it('truncates the value to the attribute length limit', async () => {
    await provider.shutdown();
    setup([new ScopedBaggageSpanProcessor({ [AWS_AGENT_LINEAGE]: INFERENCE_SCOPE })], {
      attributeValueLengthLimit: 6,
    });

    startSpan().end();

    expect(finished('chat model').attributes[AWS_AGENT_LINEAGE]).toBe(LINEAGE.slice(0, 6));
  });

  it('uses baggage captured at start when the span ends in another context', () => {
    const span = startSpan();
    context.with(ROOT_CONTEXT, () => span.end());

    expect(finished('chat model').attributes[AWS_AGENT_LINEAGE]).toBe(LINEAGE);
  });

  it('ignores keys with unknown scopes', () => {
    const processor = new ScopedBaggageSpanProcessor({ 'my.key': 'no_such_scope' });
    expect(processor['_scopedKeys'].size).toBe(0);
  });

  it('stamps only the innermost CLIENT span when nested with GenAINestedClientSpanProcessor', async () => {
    await provider.shutdown();
    setup([
      new GenAINestedClientSpanProcessor(),
      new ScopedBaggageSpanProcessor({ [AWS_AGENT_LINEAGE]: INFERENCE_SCOPE }),
    ]);

    const framework = startSpan('framework chat');
    const sdk = startSpan(
      'bedrock chat',
      GEN_AI_OPERATION_NAME_VALUE_CHAT,
      SpanKind.CLIENT,
      trace.setSpan(lineageContext, framework)
    );
    sdk.end();
    framework.end();

    expect(finished('framework chat').kind).toBe(SpanKind.INTERNAL);
    expect(finished('framework chat').attributes[AWS_AGENT_LINEAGE]).toBeUndefined();
    expect(finished('bedrock chat').attributes[AWS_AGENT_LINEAGE]).toBe(LINEAGE);
  });

  it('leaves unscoped keys on every span', async () => {
    await provider.shutdown();
    setup([
      new ScopedBaggageSpanProcessor({ [AWS_AGENT_LINEAGE]: INFERENCE_SCOPE }),
      new BaggageSpanProcessor((key: string) => key === 'session.id'),
    ]);
    const ctx = contextWithBaggage({ [AWS_AGENT_LINEAGE]: LINEAGE, 'session.id': 's-1' });

    startSpan('agent', null, SpanKind.INTERNAL, ctx).end();
    startSpan('chat model', GEN_AI_OPERATION_NAME_VALUE_CHAT, SpanKind.CLIENT, ctx).end();

    expect(finished('agent').attributes['session.id']).toBe('s-1');
    expect(finished('agent').attributes[AWS_AGENT_LINEAGE]).toBeUndefined();
    expect(finished('chat model').attributes['session.id']).toBe('s-1');
    expect(finished('chat model').attributes[AWS_AGENT_LINEAGE]).toBe(LINEAGE);
  });
});

describe('isGenAiInferenceSpan', () => {
  it('requires CLIENT kind and an inference operation', async () => {
    const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler() });
    const tracer = provider.getTracer('test');
    const cases: [SpanKind, string | undefined, boolean][] = [
      [SpanKind.CLIENT, GEN_AI_OPERATION_NAME_VALUE_CHAT, true],
      [SpanKind.INTERNAL, GEN_AI_OPERATION_NAME_VALUE_CHAT, false],
      [SpanKind.CLIENT, 'execute_tool', false],
      [SpanKind.CLIENT, undefined, false],
    ];
    for (const [kind, op, expected] of cases) {
      const span = tracer.startSpan('s', { kind }, ROOT_CONTEXT);
      if (op !== undefined) {
        span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, op);
      }
      span.end();
      expect(isGenAiInferenceSpan(span as any)).toBe(expected);
    }
    await provider.shutdown();
  });
});
