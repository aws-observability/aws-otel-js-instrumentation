// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, Context, ROOT_CONTEXT, propagation, SpanKind, trace } from '@opentelemetry/api';
import { BaggageSpanProcessor } from '@opentelemetry/baggage-span-processor';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { AlwaysOnSampler, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { spawnSync } from 'child_process';
import { expect } from 'expect';
import { GenAINestedClientSpanProcessor } from '../src/gen-ai-nested-client-span-processor';
import { VercelAISpanProcessor } from '../src/instrumentation/instrumentation-vercel-ai/span-processor';
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
  clearRegisteredBaggageScopes,
  registerBaggageScope,
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

  it('skips keys with unknown scopes', async () => {
    await provider.shutdown();
    setup([new ScopedBaggageSpanProcessor({ [AWS_AGENT_LINEAGE]: 'no_such_scope' })]);

    startSpan().end();

    expect(finished('chat model').attributes[AWS_AGENT_LINEAGE]).toBeUndefined();
  });

  it('does not resolve scope names inherited from Object.prototype', async () => {
    await provider.shutdown();
    setup([new ScopedBaggageSpanProcessor({ [AWS_AGENT_LINEAGE]: 'constructor' })]);

    startSpan('internal', null, SpanKind.INTERNAL).end();

    expect(finished('internal').attributes[AWS_AGENT_LINEAGE]).toBeUndefined();
  });

  it('copies keys whose names match Object.prototype properties', async () => {
    await provider.shutdown();
    setup([new ScopedBaggageSpanProcessor({ constructor: INFERENCE_SCOPE, toString: INFERENCE_SCOPE })]);

    startSpan(
      'chat model',
      GEN_AI_OPERATION_NAME_VALUE_CHAT,
      SpanKind.CLIENT,
      contextWithBaggage({ constructor: 'c', toString: 't' })
    ).end();

    const attributes = finished('chat model').attributes;
    expect(Object.prototype.hasOwnProperty.call(attributes, 'constructor')).toBe(true);
    expect(attributes['constructor']).toBe('c');
    expect(attributes['toString']).toBe('t');
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

  it('stamps Vercel AI inference spans that start as INTERNAL and are promoted to CLIENT', async () => {
    await provider.shutdown();
    // Same order as production: VercelAISpanProcessor is inserted at the front of the processor list.
    setup([
      new VercelAISpanProcessor(),
      new GenAINestedClientSpanProcessor(),
      new ScopedBaggageSpanProcessor({ [AWS_AGENT_LINEAGE]: INFERENCE_SCOPE }),
    ]);
    const vercelTracer = provider.getTracer('ai');

    const span = vercelTracer.startSpan('ai.generateText.doGenerate', { kind: SpanKind.INTERNAL }, lineageContext);
    span.setAttribute('ai.operationId', 'ai.generateText.doGenerate');
    span.end();

    const exported = exporter.getFinishedSpans()[0];
    expect(exported.kind).toBe(SpanKind.CLIENT);
    expect(exported.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe(GEN_AI_OPERATION_NAME_VALUE_CHAT);
    expect(exported.attributes[AWS_AGENT_LINEAGE]).toBe(LINEAGE);
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

describe('registerBaggageScope', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let tracer: ReturnType<NodeTracerProvider['getTracer']>;
  const ctx = contextWithBaggage({ 'my.key': 'v1' });
  const isToolSpan = (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool';

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    // As configured from OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS=my.key:tools before the scope is registered.
    provider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [new ScopedBaggageSpanProcessor({ 'my.key': 'tools' }), new SimpleSpanProcessor(exporter)],
    });
    tracer = provider.getTracer('test');
  });

  afterEach(async () => {
    clearRegisteredBaggageScopes();
    await provider.shutdown();
  });

  function finished(name: string) {
    return exporter.getFinishedSpans().find(span => span.name === name)!;
  }

  function toolSpan(name: string = 'tool') {
    const span = tracer.startSpan(name, {}, ctx);
    span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, 'execute_tool');
    return span;
  }

  it('applies a registered scope to keys mapped in the environment variable', () => {
    expect(registerBaggageScope('tools', isToolSpan)).toBe(true);

    toolSpan().end();
    tracer.startSpan('other', {}, ctx).end();

    expect(finished('tool').attributes['my.key']).toBe('v1');
    expect(finished('other').attributes['my.key']).toBeUndefined();
  });

  it('applies a scope registered after the span started', () => {
    const span = toolSpan();
    registerBaggageScope('tools', isToolSpan);
    span.end();

    expect(finished('tool').attributes['my.key']).toBe('v1');
  });

  it('does not copy the key before the scope is registered', () => {
    toolSpan('before').end();
    registerBaggageScope('tools', isToolSpan);
    toolSpan('after').end();

    expect(finished('before').attributes['my.key']).toBeUndefined();
    expect(finished('after').attributes['my.key']).toBe('v1');
  });

  it('replaces a scope registered again under the same name', () => {
    registerBaggageScope('tools', () => false);
    registerBaggageScope('tools', isToolSpan);
    toolSpan().end();

    expect(finished('tool').attributes['my.key']).toBe('v1');
  });

  it('skips the key when the predicate throws', () => {
    registerBaggageScope('tools', () => {
      throw new Error('boom');
    });
    toolSpan().end();

    expect(finished('tool').attributes['my.key']).toBeUndefined();
  });

  it('copies the key when any of its scopes matches', async () => {
    await provider.shutdown();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        new ScopedBaggageSpanProcessor({ 'my.key': ['tools', INFERENCE_SCOPE, 'no_such_scope'] }),
        new SimpleSpanProcessor(exporter),
      ],
    });
    tracer = provider.getTracer('test');
    registerBaggageScope('tools', isToolSpan);

    toolSpan().end();
    const chat = tracer.startSpan('chat', { kind: SpanKind.CLIENT }, ctx);
    chat.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
    chat.end();
    tracer.startSpan('other', {}, ctx).end();

    expect(finished('tool').attributes['my.key']).toBe('v1');
    expect(finished('chat').attributes['my.key']).toBe('v1');
    expect(finished('other').attributes['my.key']).toBeUndefined();
  });

  it("does not let a throwing predicate block the key's other scopes", async () => {
    await provider.shutdown();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        new ScopedBaggageSpanProcessor({ 'my.key': ['broken', 'tools'] }),
        new SimpleSpanProcessor(exporter),
      ],
    });
    tracer = provider.getTracer('test');
    registerBaggageScope('broken', () => {
      throw new Error('boom');
    });
    registerBaggageScope('tools', isToolSpan);

    toolSpan().end();

    expect(finished('tool').attributes['my.key']).toBe('v1');
  });

  it('rejects invalid registrations', () => {
    for (const name of ['', ' tools', 'a:b', 'a,b', INFERENCE_SCOPE, 'aws.tools']) {
      expect(registerBaggageScope(name, isToolSpan)).toBe(false);
    }
    expect(registerBaggageScope('tools', 'not a function' as unknown as () => boolean)).toBe(false);
  });

  it('keeps the built-in scope after a rejected override', async () => {
    registerBaggageScope(INFERENCE_SCOPE, () => true);
    await provider.shutdown();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        new ScopedBaggageSpanProcessor({ 'my.key': INFERENCE_SCOPE }),
        new SimpleSpanProcessor(exporter),
      ],
    });
    provider.getTracer('test').startSpan('internal', {}, ctx).end();

    expect(finished('internal').attributes['my.key']).toBeUndefined();
  });

  it('allows custom scope names that match Object.prototype properties', () => {
    expect(registerBaggageScope('constructor', isToolSpan)).toBe(true);
  });

  it('treats unprefixed inference as a custom scope name', () => {
    expect(registerBaggageScope('inference', isToolSpan)).toBe(true);
  });
});

describe('registerBaggageScope through the public register entry point', () => {
  // Customers can only import ./register and ./lite because of the package exports map. Each case runs
  // in a child process because loading register starts the distro.
  const baseEnv = {
    OTEL_NODE_RESOURCE_DETECTORS: 'none',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
  };

  function run(script: string, env: Record<string, string>) {
    const proc = spawnSync(process.execPath, ['-e', script], {
      cwd: __dirname,
      timeout: 20000,
      killSignal: 'SIGKILL',
      env: Object.assign({}, process.env, baseEnv, env),
    });
    expect(proc.error).toBeUndefined();
    return proc;
  }

  const stampScript = `
    const { context, propagation, SpanKind, trace } = require('@opentelemetry/api');
    function toolSpanAttributes() {
      const ctx = propagation.setBaggage(
        context.active(),
        propagation.createBaggage({ 'my.key': { value: 'v1' }, 'aws.agent.lineage': { value: 'a,b' } })
      );
      const span = trace.getTracer('t').startSpan('tool', { kind: SpanKind.INTERNAL }, ctx);
      span.setAttribute('gen_ai.operation.name', 'execute_tool');
      span.end();
      return span.attributes;
    }
  `;

  it('copies an env-mapped key with a scope registered through ./register', () => {
    const script =
      stampScript +
      `
      const m = require('@aws/aws-distro-opentelemetry-node-autoinstrumentation/register');
      const ok = m.registerBaggageScope('tools', s => s.attributes['gen_ai.operation.name'] === 'execute_tool');
      const attrs = toolSpanAttributes();
      process.exit(ok && attrs['my.key'] === 'v1' && attrs['aws.agent.lineage'] === undefined ? 0 : 1);
    `;
    const proc = run(script, { AGENT_OBSERVABILITY_ENABLED: 'true', OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS: 'my.key:tools' });
    expect(proc.status).toBe(0);
  });

  it('copies :aws.inference keys only to the innermost inference span without agent observability', () => {
    const script = `
      require('@aws/aws-distro-opentelemetry-node-autoinstrumentation/register');
      const { context, propagation, SpanKind, trace } = require('@opentelemetry/api');
      const tracer = trace.getTracer('t');
      const ctx = propagation.setBaggage(context.active(), propagation.createBaggage({ 'tenant.id': { value: 't1' } }));
      // The SDK span's parent context is built both from the parent span and from its span context only.
      const ok = [
        framework => trace.setSpan(ctx, framework),
        framework => trace.setSpanContext(ctx, framework.spanContext()),
      ].every(parentContext => {
        const framework = tracer.startSpan('framework', { kind: SpanKind.CLIENT }, ctx);
        framework.setAttribute('gen_ai.operation.name', 'chat');
        const sdk = tracer.startSpan('sdk', { kind: SpanKind.CLIENT }, parentContext(framework));
        sdk.setAttribute('gen_ai.operation.name', 'chat');
        sdk.end();
        framework.end();
        // GenAINestedClientSpanProcessor is installed without agent observability and demotes the outer span.
        return (
          framework.kind === SpanKind.INTERNAL &&
          framework.attributes['tenant.id'] === undefined &&
          sdk.attributes['tenant.id'] === 't1'
        );
      });
      process.exit(ok ? 0 : 1);
    `;
    const proc = run(script, {
      AGENT_OBSERVABILITY_ENABLED: 'false',
      OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS: 'tenant.id:aws.inference',
    });
    expect(proc.status).toBe(0);
  });

  it('shares registered scopes with a second copy of the distro', () => {
    const script =
      stampScript +
      `
      const path = require('path');
      const entry = require.resolve('@aws/aws-distro-opentelemetry-node-autoinstrumentation/register');
      const first = require(entry);
      const buildDir = path.dirname(entry);
      for (const id of Object.keys(require.cache)) {
        if (id.startsWith(buildDir)) delete require.cache[id];
      }
      const second = require(entry);
      if (second === first) process.exit(3);
      second.registerBaggageScope('tools', s => s.attributes['gen_ai.operation.name'] === 'execute_tool');
      process.exit(toolSpanAttributes()['my.key'] === 'v1' ? 0 : 1);
    `;
    const proc = run(script, { AGENT_OBSERVABILITY_ENABLED: 'true', OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS: 'my.key:tools' });
    expect(proc.status).toBe(0);
  });

  for (const agentObservability of ['true', 'false']) {
    it(`exports a callable hook in Lambda fast-start mode (agent observability ${agentObservability})`, () => {
      const proc = run(
        "const m = require('@aws/aws-distro-opentelemetry-node-autoinstrumentation/register');" +
          "if (typeof m.registerBaggageScope !== 'function') process.exit(2);" +
          "process.exit(m.registerBaggageScope('tools', () => true) === true ? 0 : 1);",
        { OTEL_AWS_LAMBDA_FAST_START: 'true', AGENT_OBSERVABILITY_ENABLED: agentObservability }
      );
      expect(proc.status).toBe(0);
    });
  }
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
