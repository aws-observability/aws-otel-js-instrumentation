// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { instrumentation } from './load-instrumentation';
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
  ATTR_GEN_AI_OUTPUT_TYPE,
} from '../../../src/instrumentation/common/semconv';
import { expect } from 'expect';
import { generateText, streamText, tool, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { z } from 'zod';
import {
  mockFetchJson,
  OPENAI_CHAT_RESPONSE,
  OPENAI_TOOL_CALL_RESPONSE,
  ANTHROPIC_CHAT_RESPONSE,
  BEDROCK_CHAT_RESPONSE,
} from '../mock-responses';

const OPENAI_MODEL = 'gpt-4o-mini';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-20250514-v1:0';

type Provider = 'openai' | 'anthropic' | 'bedrock';

function createProvider(provider: Provider, fetchFn: typeof fetch) {
  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey: 'sk-test', fetch: fetchFn });
    case 'anthropic':
      return createAnthropic({ apiKey: 'sk-ant-test', fetch: fetchFn });
    case 'bedrock':
      return createAmazonBedrock({
        region: 'us-east-1',
        accessKeyId: 'testing',
        secretAccessKey: 'testing',
        fetch: fetchFn,
      });
  }
}

function getModel(provider: Provider, providerInstance: any) {
  switch (provider) {
    case 'openai':
      return providerInstance.chat(OPENAI_MODEL);
    case 'anthropic':
      return providerInstance(ANTHROPIC_MODEL);
    case 'bedrock':
      return providerInstance(BEDROCK_MODEL);
  }
}

describe('Vercel AI generateText - basic chat spans', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: false });
  });

  it('creates an OpenAI chat span with correct attributes', async () => {
    const provider = createProvider('openai', mockFetchJson(OPENAI_CHAT_RESPONSE));
    const model = getModel('openai', provider);

    const result = await generateText({
      model,
      prompt: 'What is the capital of France?',
      maxOutputTokens: 256,
      temperature: 0.7,
    });

    expect(result.text).toContain('Paris');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBeGreaterThanOrEqual(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('openai');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(OPENAI_MODEL);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(18);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(8);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
  });

  it('creates an Anthropic chat span with correct attributes', async () => {
    const provider = createProvider('anthropic', mockFetchJson(ANTHROPIC_CHAT_RESPONSE));
    const model = getModel('anthropic', provider);

    const result = await generateText({
      model,
      prompt: 'What is the capital of France?',
      maxOutputTokens: 256,
    });

    expect(result.text).toContain('Paris');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBeGreaterThanOrEqual(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('anthropic');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(ANTHROPIC_MODEL);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(25);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
  });

  it('creates a Bedrock chat span with correct attributes', async () => {
    const provider = createProvider('bedrock', mockFetchJson(BEDROCK_CHAT_RESPONSE));
    const model = getModel('bedrock', provider);

    const result = await generateText({
      model,
      prompt: 'What is the capital of France?',
      maxOutputTokens: 256,
    });

    expect(result.text).toContain('Paris');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBeGreaterThanOrEqual(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('aws.bedrock');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(BEDROCK_MODEL);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(25);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
  });

  it('maps request parameters correctly', async () => {
    const provider = createProvider('openai', mockFetchJson(OPENAI_CHAT_RESPONSE));
    const model = getModel('openai', provider);

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

  it('sets output type to text for generateText', async () => {
    const provider = createProvider('openai', mockFetchJson(OPENAI_CHAT_RESPONSE));
    const model = getModel('openai', provider);

    await generateText({ model, prompt: 'test' });

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBeGreaterThanOrEqual(1);
    expect(chatSpans[0].attributes[ATTR_GEN_AI_OUTPUT_TYPE]).toBe('text');
  });
});

describe('Vercel AI generateText - content capture', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    instrumentation.setConfig({ captureMessageContent: false });
  });

  it('captures input and output messages when captureMessageContent is enabled', async () => {
    instrumentation.setConfig({ captureMessageContent: true });

    const provider = createProvider('openai', mockFetchJson(OPENAI_CHAT_RESPONSE));
    const model = getModel('openai', provider);

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
    expect(inputMessages[0].role).toBe('user');
    expect(inputMessages[0].parts[0].type).toBe('text');

    const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
    expect(outputMessages[0].role).toBe('assistant');
    expect(outputMessages[0].parts[0].type).toBe('text');
  });

  it('does not capture messages when captureMessageContent is disabled', async () => {
    instrumentation.setConfig({ captureMessageContent: false });

    const provider = createProvider('openai', mockFetchJson(OPENAI_CHAT_RESPONSE));
    const model = getModel('openai', provider);

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

describe('Vercel AI generateText - tool calls', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: true });
  });

  afterEach(() => {
    instrumentation.setConfig({ captureMessageContent: false });
  });

  it('creates tool execution spans with correct attributes', async () => {
    let callCount = 0;
    const mockFetch = (async () => {
      callCount++;
      const body =
        callCount === 1
          ? OPENAI_TOOL_CALL_RESPONSE
          : {
              ...OPENAI_CHAT_RESPONSE,
              choices: [
                {
                  ...OPENAI_CHAT_RESPONSE.choices[0],
                  message: { role: 'assistant', content: 'It is sunny in Tokyo.' },
                },
              ],
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const provider = createProvider('openai', mockFetch);
    const model = getModel('openai', provider);

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
  });

  it('maps tool_calls finish reason correctly', async () => {
    const provider = createProvider('openai', mockFetchJson(OPENAI_TOOL_CALL_RESPONSE));
    const model = getModel('openai', provider);

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
        s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat' && s.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] != null
    );
    expect(chatSpans.length).toBeGreaterThanOrEqual(1);
    // Vercel AI SDK normalizes 'tool_calls' to 'tool-calls' and our processor
    // maps it to 'tool_call'. For the doGenerate child span this mapping applies.
    const reasons = chatSpans[0].attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] as string[];
    expect(reasons[0]).toMatch(/tool.call/);
  });
});

describe('Vercel AI generateText - agent detection', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: true });
  });

  afterEach(() => {
    instrumentation.setConfig({ captureMessageContent: false });
  });

  it('detects agent span when tools are used with multiple steps', async () => {
    let callCount = 0;
    const mockFetch = (async () => {
      callCount++;
      const body =
        callCount === 1
          ? OPENAI_TOOL_CALL_RESPONSE
          : {
              ...OPENAI_CHAT_RESPONSE,
              choices: [{ ...OPENAI_CHAT_RESPONSE.choices[0], message: { role: 'assistant', content: 'Done.' } }],
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const provider = createProvider('openai', mockFetch);
    const model = getModel('openai', provider);

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
  });

  it('does not create agent span for simple chat without tools', async () => {
    const provider = createProvider('openai', mockFetchJson(OPENAI_CHAT_RESPONSE));
    const model = getModel('openai', provider);

    await generateText({
      model,
      prompt: 'Hello',
    });

    const spans = getTestSpans();
    const agentSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
    expect(agentSpans.length).toBe(0);
  });
});

describe('Vercel AI streamText', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: false });
  });

  it('creates a chat span for streaming', async () => {
    // OpenAI chat completions streaming SSE format
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

    const provider = createOpenAI({ apiKey: 'sk-test', fetch: mockFetch });
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
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('openai');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(OPENAI_MODEL);
    expect(span.attributes[ATTR_GEN_AI_OUTPUT_TYPE]).toBe('text');
  });
});

describe('Vercel AI - provider name mapping', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: false });
  });

  const providerCases: Array<{
    name: string;
    createProviderFn: () => any;
    modelId: string;
    expectedProvider: string;
    useChat?: boolean;
  }> = [
    {
      name: 'OpenAI',
      createProviderFn: () => createOpenAI({ apiKey: 'sk-test', fetch: mockFetchJson(OPENAI_CHAT_RESPONSE) }),
      modelId: OPENAI_MODEL,
      expectedProvider: 'openai',
      useChat: true,
    },
    {
      name: 'Anthropic',
      createProviderFn: () => createAnthropic({ apiKey: 'sk-ant-test', fetch: mockFetchJson(ANTHROPIC_CHAT_RESPONSE) }),
      modelId: ANTHROPIC_MODEL,
      expectedProvider: 'anthropic',
    },
    {
      name: 'Amazon Bedrock',
      createProviderFn: () =>
        createAmazonBedrock({
          region: 'us-east-1',
          accessKeyId: 'testing',
          secretAccessKey: 'testing',
          fetch: mockFetchJson(BEDROCK_CHAT_RESPONSE),
        }),
      modelId: BEDROCK_MODEL,
      expectedProvider: 'aws.bedrock',
    },
  ];

  for (const { name, createProviderFn, modelId, expectedProvider, useChat } of providerCases) {
    it(`maps ${name} provider name to "${expectedProvider}"`, async () => {
      const provider = createProviderFn();
      const model = useChat ? provider.chat(modelId) : provider(modelId);

      await generateText({
        model,
        prompt: 'test',
      });

      const spans = getTestSpans();
      const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpans.length).toBeGreaterThanOrEqual(1);
      expect(chatSpans[0].attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(expectedProvider);
    });
  }
});

describe('Vercel AI - finish reason mapping', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: false });
  });

  // Vercel AI SDK normalizes OpenAI finish reasons to its own format
  // before they reach the span attributes. Our processor then maps them
  // to OTel semantic conventions:
  //   stop -> stop, length -> length, content-filter -> content_filter
  const finishReasonCases: Array<{ openaiReason: string; expected: string }> = [
    { openaiReason: 'stop', expected: 'stop' },
    { openaiReason: 'length', expected: 'length' },
  ];

  for (const { openaiReason, expected } of finishReasonCases) {
    it(`maps "${openaiReason}" finish reason to "${expected}"`, async () => {
      const provider = createProvider(
        'openai',
        mockFetchJson({
          ...OPENAI_CHAT_RESPONSE,
          choices: [{ ...OPENAI_CHAT_RESPONSE.choices[0], finish_reason: openaiReason }],
        })
      );
      const model = getModel('openai', provider);

      await generateText({ model, prompt: 'test' });

      const spans = getTestSpans();
      const chatSpans = spans.filter(
        (s: ReadableSpan) =>
          s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat' &&
          s.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] != null
      );
      expect(chatSpans.length).toBeGreaterThanOrEqual(1);
      expect(chatSpans[0].attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual([expected]);
    });
  }
});

describe('Vercel AI - removes Vercel-specific attributes', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    instrumentation.setConfig({ captureMessageContent: false });
  });

  it('removes ai.* attributes after transformation', async () => {
    const provider = createProvider('openai', mockFetchJson(OPENAI_CHAT_RESPONSE));
    const model = getModel('openai', provider);

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
});

describe('Vercel AI - disable/enable', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  it('does not crash when generateText is called with telemetry explicitly enabled', async () => {
    const provider = createProvider('openai', mockFetchJson(OPENAI_CHAT_RESPONSE));
    const model = getModel('openai', provider);

    const result = await generateText({
      model,
      prompt: 'test',
      experimental_telemetry: { isEnabled: true },
    });

    expect(result.text).toContain('Paris');
  });
});
