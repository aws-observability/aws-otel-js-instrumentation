// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { SpanKind } from '@opentelemetry/api';
import { instrumentation, ensureSpanProcessor } from './load-instrumentation';
import { VercelAIInstrumentation } from '../../../src/instrumentation/instrumentation-vercel-ai/instrumentation';
import { VercelAISpanProcessor } from '../../../src/instrumentation/instrumentation-vercel-ai/span-processor';
import * as sinon from 'sinon';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
  ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
  ATTR_GEN_AI_REQUEST_SEED,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
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
import { generateText, streamText, tool } from 'ai';
import * as ai from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createCohere } from '@ai-sdk/cohere';
import { createXai } from '@ai-sdk/xai';
import { HttpResponse } from '@smithy/protocol-http';
import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const otelGenAISemconv = require('@opentelemetry/semantic-conventions/incubating');
const providerCases = getProviderCases();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacyCohereProvider = (require('@ai-sdk/cohere/package.json').version as string).startsWith('0.');
// The dependency matrix sets this to false when the installed AI SDK does not emit ai.prompt.tools.
const expectToolDefinitions = process.env.VERCEL_AI_EXPECT_TOOL_DEFINITIONS !== 'false';

it('uses the pinned OTel semantic convention names for mapped attributes', function () {
  expect(ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK).toBe(otelGenAISemconv.ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK);
  expect(ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS).toBe(
    otelGenAISemconv.ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS
  );
  expect(ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS).toBe(otelGenAISemconv.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS);
  expect(ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS).toBe(otelGenAISemconv.ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS);
});

function stepLimit(steps: number) {
  if ('stepCountIs' in ai && typeof ai.stepCountIs === 'function') {
    return { stopWhen: ai.stepCountIs(steps) };
  }
  return { maxSteps: steps };
}

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
        bedrockOptions: {
          region: AWS_REGION,
          credentials: {
            accessKeyId: FAKE_AWS_ACCESS_KEY_ID,
            secretAccessKey: FAKE_AWS_SECRET_ACCESS_KEY,
          },
          requestHandler: {
            async handle() {
              const response = await fetch('https://bedrock-runtime.test');
              return {
                response: new HttpResponse({
                  statusCode: response.status,
                  headers: Object.fromEntries(response.headers.entries()),
                  body: new Uint8Array(await response.arrayBuffer()),
                }),
              };
            },
            updateHttpClientConfig() {},
            httpHandlerConfigs() {
              return {};
            },
          },
        },
      } as any);
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

function createVercelSpan(
  attributes: Record<string, unknown>,
  ids: { spanId?: string; parentSpanId?: string } = {}
): ReadableSpan {
  const spanId = ids.spanId ?? '1'.repeat(16);
  return {
    name: 'ai.test',
    kind: SpanKind.INTERNAL,
    instrumentationScope: { name: 'ai' },
    attributes,
    parentSpanContext: ids.parentSpanId
      ? { traceId: '0'.repeat(32), spanId: ids.parentSpanId, traceFlags: 1 }
      : undefined,
    spanContext: () => ({
      traceId: '0'.repeat(32),
      spanId,
      traceFlags: 1,
    }),
  } as unknown as ReadableSpan;
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

  it('maps seed, cache usage, reasoning usage, and response timing', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.settings.seed': 42,
      'ai.usage.cachedInputTokens': 7,
      'ai.usage.inputTokenDetails.cacheWriteTokens': 3,
      'ai.usage.outputTokenDetails.reasoningTokens': 4,
      'ai.response.msToFirstChunk': 250,
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_REQUEST_SEED]).toBe(42);
    expect(attributes[ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(7);
    expect(attributes[ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(3);
    expect(attributes[ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]).toBe(4);
    expect(attributes[ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK]).toBe(0.25);
    expect(attributes['gen_ai.usage.cache_read_input_tokens']).toBeUndefined();
    expect(attributes['gen_ai.usage.cache_creation_input_tokens']).toBeUndefined();
  });

  it('maps stream time to first chunk from milliseconds to seconds', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.streamObject.doStream',
      'ai.stream.msToFirstChunk': 125,
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK]).toBe(0.125);
  });

  it('maps legacy reasoning token usage', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.usage.reasoningTokens': 5,
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]).toBe(5);
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

  it('normalizes image and tool content with the Vercel adapter', function () {
    expect(
      (VercelAISpanProcessor as any)._formatMessageParts([
        { type: 'text', text: 'describe' },
        { type: 'reasoning', text: 'Use the lookup tool.' },
        { type: 'file', data: 'AAAA', mediaType: 'image/png' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', args: '{"city":"Tokyo"}' },
        { type: 'tool-result', toolCallId: 'call_1', result: { forecast: 'sunny' } },
      ])
    ).toEqual([
      { type: 'text', content: 'describe' },
      { type: 'reasoning', content: 'Use the lookup tool.' },
      {
        type: 'blob',
        modality: 'image',
        mime_type: 'image/png',
        content: 'AAAA',
      },
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'lookup',
        arguments: { city: 'Tokyo' },
      },
      { type: 'tool_call_response', id: 'call_1', response: { forecast: 'sunny' } },
    ]);
  });

  it('maps Vercel reasoning and response tool calls to output messages alongside text', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.response.finishReason': 'tool-calls',
      [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: ['tool-calls'],
      'ai.response.reasoning': 'I should use the weather tool.',
      'ai.response.text': 'Let me check.',
      'ai.response.toolCalls': JSON.stringify([
        {
          toolCallId: 'call_1',
          toolName: 'get_weather',
          input: { location: 'Tokyo' },
        },
      ]),
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(JSON.parse(attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'I should use the weather tool.' },
          { type: 'text', content: 'Let me check.' },
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'get_weather',
            arguments: { location: 'Tokyo' },
          },
        ],
        finish_reason: 'tool_call',
      },
    ]);
    expect(attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['tool_call']);
  });

  it('preserves structured reasoning blocks emitted by future AI SDK versions', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.response.finishReason': 'stop',
      'ai.response.reasoning': [
        { type: 'reasoning', text: 'First thought.' },
        { type: 'reasoning', text: 'Second thought.' },
      ],
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(JSON.parse(attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'First thought.' },
          { type: 'reasoning', content: 'Second thought.' },
        ],
        finish_reason: 'stop',
      },
    ]);
  });

  it('maps AI SDK v3 result tool calls when the result text is empty', function () {
    const attributes: Record<string, unknown> = {
      'operation.name': 'ai.generateText.doGenerate weather_agent',
      'ai.finishReason': 'tool-calls',
      'ai.result.text': '',
      'ai.result.toolCalls': JSON.stringify([
        {
          toolCallId: 'call_1',
          toolName: 'get_weather',
          args: '{"location":"Tokyo"}',
        },
      ]),
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(JSON.parse(attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string)).toEqual([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'get_weather',
            arguments: { location: 'Tokyo' },
          },
        ],
        finish_reason: 'tool_call',
      },
    ]);
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
        ...stepLimit(3),
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
      if (expectToolDefinitions) {
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
      } else {
        expect(toolDefs).toBeUndefined();
      }

      resetMemoryExporter();
    });
  }

  it('preserves structured tool arguments and results through shared serialization', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.toolCall',
      'ai.toolCall.name': 'structured_add',
      'ai.toolCall.args': '{"a":1,"b":2}',
      'ai.toolCall.result': '{"content":{"sum":3},"artifact":{"id":"artifact-1"}}',
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]).toBe('{"a":1,"b":2}');
    expect(attributes[ATTR_GEN_AI_TOOL_CALL_RESULT]).toBe('{"content":{"sum":3},"artifact":{"id":"artifact-1"}}');
  });

  it('preserves an explicitly present empty telemetry value', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.toolCall',
      'ai.toolCall.name': 'empty_result',
      'ai.toolCall.result': '',
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_TOOL_CALL_RESULT]).toBe('');
  });

  it('maps AI SDK v4 tool parameters to tool definitions', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt.tools': [
        JSON.stringify({
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
              location: { type: 'string' },
            },
            additionalProperties: false,
          },
        }),
      ],
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(JSON.parse(attributes[ATTR_GEN_AI_TOOL_DEFINITIONS] as string)).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
        },
      },
    ]);
  });

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
        ...stepLimit(1),
      } as any);

      const spans = getTestSpans();
      const chatSpans = spans.filter(
        (s: ReadableSpan) =>
          s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat' &&
          s.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] != null
      );
      expect(chatSpans.length).toBeGreaterThanOrEqual(1);
      const reasons = chatSpans[0].attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] as string[];
      if (pc.name === ProviderName.COHERE && legacyCohereProvider) {
        expect(reasons[0]).toBe('unknown');
      } else {
        expect(reasons[0]).toBe('tool_call');
      }

      const outputMessages = JSON.parse(chatSpans[0].attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
      await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
      expect(outputMessages[0].parts).toContainEqual(
        expect.objectContaining({
          type: 'tool_call',
          name: 'get_weather',
        })
      );

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
        ...stepLimit(5),
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

  it('detects agent span when tools are declared but the model calls none', async () => {
    const model = getModel(providerCases[0]);

    const weatherTool = (tool as any)({
      description: 'Get weather',
      parameters: z.object({ location: z.string() }),
      execute: async ({ location }: { location: string }) => `Sunny in ${location}`,
    });

    await generateText({
      model,
      prompt: 'Hello',
      tools: { get_weather: weatherTool },
    } as any);

    const spans = getTestSpans();
    const agentSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
    if (expectToolDefinitions) {
      expect(agentSpans.length).toBeGreaterThanOrEqual(1);
    } else {
      expect(agentSpans.length).toBe(0);
    }
  });

  it('hoists declared tools from the inner span to classify the parent as invoke_agent', function () {
    const processor = new VercelAISpanProcessor();
    const parentSpanId = 'a'.repeat(16);

    const inner: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt.tools': [JSON.stringify({ type: 'function', name: 'emit_suggestions' })],
    };
    processor.onEnd(createVercelSpan(inner, { spanId: 'b'.repeat(16), parentSpanId }));
    expect(inner[ATTR_GEN_AI_OPERATION_NAME]).toBe('chat');

    const outer: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText',
      'ai.telemetry.functionId': 'horizon-loop-agent',
    };
    const outerSpan = createVercelSpan(outer, { spanId: parentSpanId });
    processor.onEnd(outerSpan);

    expect(outer[ATTR_GEN_AI_OPERATION_NAME]).toBe('invoke_agent');
    expect(outerSpan.name).toBe('invoke_agent horizon-loop-agent');
  });

  it('leaves the parent as chat when the inner span declares no tools', function () {
    const processor = new VercelAISpanProcessor();
    const parentSpanId = 'c'.repeat(16);

    processor.onEnd(
      createVercelSpan({ 'ai.operationId': 'ai.generateText.doGenerate' }, { spanId: 'd'.repeat(16), parentSpanId })
    );

    const outer: Record<string, unknown> = { 'ai.operationId': 'ai.generateText' };
    processor.onEnd(createVercelSpan(outer, { spanId: parentSpanId }));

    expect(outer[ATTR_GEN_AI_OPERATION_NAME]).toBe('chat');
  });
});

describe('input message normalization', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  it('normalizes the ai.prompt object emitted on the outer span', async function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText',
      'ai.prompt': JSON.stringify({
        system: [
          { role: 'system', content: 'You are terse.' },
          { role: 'system', content: 'Cite sources.' },
        ],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Any anomalies?' }] }],
      }),
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    const inputMessages = JSON.parse(attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(inputMessages, 'gen-ai-input-messages');
    expect(inputMessages).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'You are terse.' }] },
      { role: 'system', parts: [{ type: 'text', content: 'Cite sources.' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Any anomalies?' }] },
    ]);
  });

  it('normalizes a string system prompt and the prompt shorthand', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText',
      'ai.prompt': JSON.stringify({ system: 'Be brief.', prompt: 'Hello' }),
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(JSON.parse(attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string)).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'Be brief.' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
    ]);
  });

  it('normalizes the array form of prompt as messages, not as user content', async function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText',
      'ai.prompt': JSON.stringify({
        prompt: [
          { role: 'user', content: 'What is the weather?' },
          { role: 'assistant', content: [{ type: 'text', text: 'Where?' }] },
          { role: 'user', content: 'Tokyo' },
        ],
      }),
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    const inputMessages = JSON.parse(attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(inputMessages, 'gen-ai-input-messages');
    expect(inputMessages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'What is the weather?' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'Where?' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Tokyo' }] },
    ]);
  });

  it('normalizes a single SystemModelMessage system prompt', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText',
      'ai.prompt': JSON.stringify({
        system: { role: 'system', content: 'Be brief.', providerOptions: { anthropic: {} } },
        prompt: 'Hello',
      }),
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(JSON.parse(attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string)).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'Be brief.' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
    ]);
  });

  it('leaves an already normalized message array untouched', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt.messages': JSON.stringify([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]),
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(JSON.parse(attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
    ]);
  });

  it('keeps the raw value when the prompt shape is unrecognized', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText',
      'ai.prompt': '{"unexpected":true}',
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBe('{"unexpected":true}');
  });

  it('keeps the raw value when the prompt is not JSON', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText',
      'ai.prompt': 'not json{',
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBe('not json{');
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

    const result = await streamText({
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

  it('preserves unknown finish reasons', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.response.finishReason': 'unknown',
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['unknown']);
  });

  it('preserves the AI SDK other finish reason', function () {
    const attributes: Record<string, unknown> = {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.response.finishReason': 'other',
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['other']);
  });

  it('maps AI SDK 3.3 operation, finish reason, and output attributes', function () {
    const attributes: Record<string, unknown> = {
      'operation.name': 'ai.generateText.doGenerate weather_agent',
      'ai.finishReason': 'stop',
      'ai.result.text': 'Sunny',
    };

    new VercelAISpanProcessor().onEnd(createVercelSpan(attributes));

    expect(attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe('chat');
    expect(attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
    expect(JSON.parse(attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string)).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'Sunny' }],
        finish_reason: 'stop',
      },
    ]);
    expect(attributes['operation.name']).toBeUndefined();
    expect(attributes['ai.finishReason']).toBeUndefined();
    expect(attributes['ai.result.text']).toBeUndefined();
  });

  const finishReasonsByProvider: Record<string, Array<{ nativeReason: string; expected: string }>> = {
    [ProviderName.OPENAI]: [
      { nativeReason: 'stop', expected: 'stop' },
      { nativeReason: 'length', expected: 'length' },
      { nativeReason: 'content_filter', expected: 'content_filter' },
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

  describe('enable override', () => {
    afterEach(() => {
      delete process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS;
      delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
      delete process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN;
    });

    it('skips enable when disabled via OTEL_NODE_DISABLED_INSTRUMENTATIONS', () => {
      process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'aws_vercel_ai';
      const instr = new VercelAIInstrumentation();
      const superEnable = sinon.spy(Object.getPrototypeOf(VercelAIInstrumentation.prototype), 'enable');
      instr.enable();
      expect(superEnable.called).toBeFalsy();
      superEnable.restore();
    });

    it('skips enable when not in OTEL_NODE_ENABLED_INSTRUMENTATIONS', () => {
      process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = 'http,aws-sdk';
      const instr = new VercelAIInstrumentation();
      const superEnable = sinon.spy(Object.getPrototypeOf(VercelAIInstrumentation.prototype), 'enable');
      instr.enable();
      expect(superEnable.called).toBeFalsy();
      superEnable.restore();
    });

    it('calls super.enable when not disabled and no conflicts', () => {
      const instr = new VercelAIInstrumentation();
      const superEnable = sinon.spy(Object.getPrototypeOf(VercelAIInstrumentation.prototype), 'enable');
      instr.enable();
      expect(superEnable.called).toBeTruthy();
      superEnable.restore();
    });
  });
});
