// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { SpanKind } from '@opentelemetry/api';
import { instrumentation, ensureSpanProcessor } from './load-instrumentation';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
  ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_OUTPUT_TYPE,
  GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
} from '../../../src/instrumentation/common/semconv';
import { expect } from 'expect';
import { validateOtelGenaiSchema } from '../otel-schema-validator';
import {
  ProviderTestCase,
  ProviderName,
  getProviderCases,
  mockFetchJson,
  chatResponseWithFinishReason,
  OPENAI_MODEL,
  FAKE_OPENAI_KEY,
  FAKE_ANTHROPIC_KEY,
  FAKE_GOOGLE_KEY,
  FAKE_GROQ_KEY,
  FAKE_MISTRAL_KEY,
  FAKE_COHERE_KEY,
  FAKE_XAI_KEY,
  FAKE_AWS_ACCESS_KEY_ID,
  FAKE_AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
} from '../test-fixtures';
import { generateText, streamText, tool, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createCohere } from '@ai-sdk/cohere';
import { createXai } from '@ai-sdk/xai';
import { z } from 'zod';

const providerCases = getProviderCases();

function createProvider(pc: ProviderTestCase, fetch: typeof globalThis.fetch = mockFetchJson(pc.chatResponse)): any {
  switch (pc.name) {
    case ProviderName.OPENAI:
      return createOpenAI({ apiKey: FAKE_OPENAI_KEY, fetch });
    case ProviderName.ANTHROPIC:
      return createAnthropic({ apiKey: FAKE_ANTHROPIC_KEY, fetch });
    case ProviderName.BEDROCK:
      return createAmazonBedrock({
        region: AWS_REGION,
        accessKeyId: FAKE_AWS_ACCESS_KEY_ID,
        secretAccessKey: FAKE_AWS_SECRET_ACCESS_KEY,
        fetch,
      });
    case ProviderName.GOOGLE:
      return createGoogleGenerativeAI({ apiKey: FAKE_GOOGLE_KEY, fetch });
    case ProviderName.GROQ:
      return createGroq({ apiKey: FAKE_GROQ_KEY, fetch });
    case ProviderName.MISTRAL:
      return createMistral({ apiKey: FAKE_MISTRAL_KEY, fetch });
    case ProviderName.COHERE:
      return createCohere({ apiKey: FAKE_COHERE_KEY, fetch });
    case ProviderName.XAI:
      return createXai({ apiKey: FAKE_XAI_KEY, fetch });
  }
}

function getModel(pc: ProviderTestCase, fetch?: typeof globalThis.fetch) {
  const provider = createProvider(pc, fetch);
  return pc.useChat ? provider.chat(pc.expectedModel) : provider(pc.expectedModel);
}

function mockMultiStepFetch(pc: ProviderTestCase): typeof globalThis.fetch {
  let callCount = 0;
  return (async () => {
    callCount++;
    const body = callCount === 1 ? pc.toolCallResponse : pc.chatResponse;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

before(() => {
  ensureSpanProcessor();
});

describe('generateText basic chat spans', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: false });
  });

  for (const pc of providerCases) {
    it(`${pc.name} creates a chat span with correct attributes`, async () => {
      const model = getModel(pc);

      const result = await generateText({
        model,
        prompt: 'What is the capital of France?',
      });

      expect(result.text).toContain('Paris');

      const spans = getTestSpans();
      const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpans.length).toBeGreaterThanOrEqual(1);

      const span = chatSpans[0];
      expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(pc.expectedProvider);
      expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(pc.expectedModel);
      expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(pc.expectedInputTokens);
      expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(pc.expectedOutputTokens);
      expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
      expect(span.attributes[ATTR_GEN_AI_OUTPUT_TYPE]).toBe('text');
      expect(span.kind).toBe(SpanKind.CLIENT);
    });
  }

  it('maps request parameters correctly', async () => {
    const model = getModel(providerCases[0]);

    await generateText({
      model,
      prompt: 'test',
      maxOutputTokens: 512,
      temperature: 0.9,
      topP: 0.95,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
    });

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBeGreaterThanOrEqual(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MAX_TOKENS]).toBe(512);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_TEMPERATURE]).toBe(0.9);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_TOP_P]).toBe(0.95);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY]).toBe(0.5);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY]).toBe(0.3);
  });
});

describe('generateText content capture', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    instrumentation.setConfig({ captureMessageContent: false });
  });

  for (const pc of providerCases) {
    it(`${pc.name} captures and validates input/output messages`, async () => {
      instrumentation.setConfig({ captureMessageContent: true });

      const model = getModel(pc);

      await generateText({
        model,
        prompt: 'What is the capital of France?',
      });

      const spans = getTestSpans();
      const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpans.length).toBeGreaterThanOrEqual(1);

      const span = chatSpans[0];
      expect(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeDefined();
      expect(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeDefined();

      const inputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
      await validateOtelGenaiSchema(inputMessages, 'gen-ai-input-messages');
      expect(inputMessages[0].role).toBe('user');
      expect(inputMessages[0].parts[0].type).toBe('text');

      const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
      await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
      expect(outputMessages[0].role).toBe('assistant');
      expect(outputMessages[0].parts[0].type).toBe('text');

      resetMemoryExporter();
    });
  }

  it('does not capture messages when captureMessageContent is disabled', async () => {
    instrumentation.setConfig({ captureMessageContent: false });

    const model = getModel(providerCases[0]);

    await generateText({
      model,
      prompt: 'What is the capital of France?',
    });

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBeGreaterThanOrEqual(1);
    expect(chatSpans[0].attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(chatSpans[0].attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
  });
});

describe('generateText tool calls', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: true });
  });

  afterEach(() => {
    instrumentation.setConfig({ captureMessageContent: false });
  });

  for (const pc of providerCases) {
    it(`${pc.name} creates tool execution spans with correct attributes`, async () => {
      const fetch = mockMultiStepFetch(pc);
      const model = getModel(pc, fetch);

      const weatherTool = (tool as any)({
        description: 'Get weather for a location',
        parameters: z.object({ location: z.string() }),
        execute: async ({ location }: { location: string }) => `Sunny in ${location}`,
      });

      await generateText({
        model,
        prompt: 'What is the weather in Tokyo?',
        tools: { get_weather: weatherTool },
        stopWhen: stepCountIs(3),
      } as any);

      const spans = getTestSpans();
      const toolSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool');
      expect(toolSpans.length).toBeGreaterThanOrEqual(1);

      const toolSpan = toolSpans[0];
      expect(toolSpan.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('get_weather');
      expect(toolSpan.attributes[ATTR_GEN_AI_TOOL_TYPE]).toBe('function');
      expect(toolSpan.attributes[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]).toBeDefined();
      expect(toolSpan.attributes[ATTR_GEN_AI_TOOL_CALL_RESULT]).toBeDefined();
      expect(toolSpan.kind).toBe(SpanKind.INTERNAL);

      const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      const toolDefs = chatSpans
        .map((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_TOOL_DEFINITIONS] as string)
        .find(v => v != null);
      expect(toolDefs).toBeDefined();
      const parsed = JSON.parse(toolDefs!);
      expect(Array.isArray(parsed)).toBe(true);
      const def = parsed.find((t: any) => t.name === 'get_weather');
      expect(def).toBeDefined();
      expect(def.type).toBe('function');
      expect(def.description).toBe('Get weather for a location');
      expect(def.parameters).toBeDefined();
      expect(def.parameters.$schema).toBeUndefined();
      expect(def.parameters.additionalProperties).toBeUndefined();
      expect(def.inputSchema).toBeUndefined();

      resetMemoryExporter();
    });
  }

  for (const pc of providerCases) {
    it(`${pc.name} maps tool_calls finish reason correctly`, async () => {
      const model = getModel(pc, mockFetchJson(pc.toolCallResponse));

      const weatherTool = (tool as any)({
        description: 'Get weather',
        parameters: z.object({ location: z.string() }),
        execute: async ({ location }: { location: string }) => `Sunny in ${location}`,
      });

      await generateText({
        model,
        prompt: 'What is the weather in Tokyo?',
        tools: { get_weather: weatherTool },
        stopWhen: stepCountIs(1),
      } as any);

      const spans = getTestSpans();
      const chatSpans = spans.filter(
        (s: ReadableSpan) =>
          s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat' &&
          s.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] != null
      );
      expect(chatSpans.length).toBeGreaterThanOrEqual(1);
      const reasons = chatSpans[0].attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] as string[];
      expect(reasons[0]).toMatch(/tool.call/);

      resetMemoryExporter();
    });
  }
});

describe('generateText agent detection', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: true });
  });

  afterEach(() => {
    instrumentation.setConfig({ captureMessageContent: false });
  });

  for (const pc of providerCases) {
    it(`${pc.name} detects agent span when tools are used with multiple steps`, async () => {
      const fetch = mockMultiStepFetch(pc);
      const model = getModel(pc, fetch);

      const weatherTool = (tool as any)({
        description: 'Get weather',
        parameters: z.object({ location: z.string() }),
        execute: async ({ location }: { location: string }) => `Sunny in ${location}`,
      });

      await generateText({
        model,
        prompt: 'What is the weather in Tokyo?',
        tools: { get_weather: weatherTool },
        stopWhen: stepCountIs(5),
      } as any);

      const spans = getTestSpans();
      const agentSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
      expect(agentSpans.length).toBeGreaterThanOrEqual(1);
      expect(agentSpans[0].kind).toBe(SpanKind.INTERNAL);

      resetMemoryExporter();
    });
  }

  it('does not create agent span for simple chat without tools', async () => {
    const model = getModel(providerCases[0]);

    await generateText({
      model,
      prompt: 'Hello',
    });

    const spans = getTestSpans();
    const agentSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
    expect(agentSpans.length).toBe(0);
  });
});

describe('streamText', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: false });
  });

  it('creates a chat span for streaming', async () => {
    const sseBody = [
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const mockFetch = (async () => {
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const provider = createOpenAI({ apiKey: FAKE_OPENAI_KEY, fetch: mockFetch });
    const model = provider.chat(OPENAI_MODEL);

    const result = streamText({
      model,
      prompt: 'Say hello',
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toContain('Hello');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBeGreaterThanOrEqual(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_NAME_VALUE_OPENAI);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(OPENAI_MODEL);
    expect(span.attributes[ATTR_GEN_AI_OUTPUT_TYPE]).toBe('text');
  });
});

describe('finish reason mapping', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: false });
  });

  const finishReasonsByProvider: Record<string, Array<{ nativeReason: string; expected: string }>> = {
    [ProviderName.OPENAI]: [
      { nativeReason: 'stop', expected: 'stop' },
      { nativeReason: 'length', expected: 'length' },
      { nativeReason: 'content_filter', expected: 'content-filter' },
    ],
    [ProviderName.ANTHROPIC]: [
      { nativeReason: 'end_turn', expected: 'stop' },
      { nativeReason: 'max_tokens', expected: 'length' },
    ],
    [ProviderName.BEDROCK]: [
      { nativeReason: 'end_turn', expected: 'stop' },
      { nativeReason: 'max_tokens', expected: 'length' },
    ],
    [ProviderName.GOOGLE]: [
      { nativeReason: 'STOP', expected: 'stop' },
      { nativeReason: 'MAX_TOKENS', expected: 'length' },
    ],
    [ProviderName.GROQ]: [
      { nativeReason: 'stop', expected: 'stop' },
      { nativeReason: 'length', expected: 'length' },
    ],
    [ProviderName.MISTRAL]: [
      { nativeReason: 'stop', expected: 'stop' },
      { nativeReason: 'length', expected: 'length' },
    ],
    [ProviderName.COHERE]: [
      { nativeReason: 'COMPLETE', expected: 'stop' },
      { nativeReason: 'MAX_TOKENS', expected: 'length' },
    ],
    [ProviderName.XAI]: [
      { nativeReason: 'stop', expected: 'stop' },
      { nativeReason: 'length', expected: 'length' },
    ],
  };

  for (const pc of providerCases) {
    const cases = finishReasonsByProvider[pc.name] || [];
    for (const { nativeReason, expected } of cases) {
      it(`${pc.name} maps "${nativeReason}" to "${expected}"`, async () => {
        const response = chatResponseWithFinishReason(pc, nativeReason);
        const model = getModel(pc, mockFetchJson(response));

        await generateText({ model, prompt: 'test' });

        const spans = getTestSpans();
        const chatSpans = spans.filter(
          (s: ReadableSpan) =>
            s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat' &&
            s.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] != null
        );
        expect(chatSpans.length).toBeGreaterThanOrEqual(1);
        expect(chatSpans[0].attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual([expected]);

        resetMemoryExporter();
      });
    }
  }
});

describe('removes Vercel-specific attributes', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: false });
  });

  for (const pc of providerCases) {
    it(`${pc.name} removes ai.* attributes after transformation`, async () => {
      const model = getModel(pc);

      await generateText({
        model,
        prompt: 'test',
      });

      const spans = getTestSpans();
      const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpans.length).toBeGreaterThanOrEqual(1);

      const span = chatSpans[0];
      const attrKeys = Object.keys(span.attributes);
      const aiDotKeys = attrKeys.filter(k => k.startsWith('ai.') && !k.startsWith('ai.telemetry.metadata.'));
      expect(aiDotKeys.length).toBe(0);
    });
  }
});

describe('disable/enable', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  it('does not crash when generateText is called with telemetry explicitly enabled', async () => {
    const model = getModel(providerCases[0]);

    const result = await generateText({
      model,
      prompt: 'test',
      experimental_telemetry: { isEnabled: true },
    });

    expect(result.text).toContain('Paris');
  });
});
