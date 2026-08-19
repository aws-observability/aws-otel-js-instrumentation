// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { instrumentation } from './load-instrumentation';
import { OpenAIAgentsInstrumentation } from '../../../src/instrumentation/instrumentation-openai-agents/instrumentation';
import { OpenTelemetryTracingProcessor } from '../../../src/instrumentation/instrumentation-openai-agents/tracing-processor';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import * as sinon from 'sinon';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
  GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
} from '../../../src/instrumentation/common/semconv';
import {
  AWS_REGION,
  BEDROCK_MODEL,
  FAKE_AWS_ACCESS_KEY_ID,
  FAKE_AWS_SECRET_ACCESS_KEY,
  FAKE_ANTHROPIC_KEY,
  FAKE_COHERE_KEY,
  FAKE_GOOGLE_KEY,
  FAKE_GROQ_KEY,
  FAKE_MISTRAL_KEY,
  FAKE_OPENAI_KEY,
  FAKE_XAI_KEY,
  OPENAI_MODEL,
  OPENAI_RESPONSES_API_CHAT_RESPONSE,
  OPENAI_RESPONSES_API_CHAT_RESPONSE_WITH_TOOLS,
  OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE,
  OPENAI_RESPONSES_API_ERROR_RESPONSE,
  ProviderName,
  ProviderTestCase,
  getProviderCases,
  mockFetchJson,
} from '../test-fixtures';
import { expect } from 'expect';
import { validateOtelGenaiSchema } from '../otel-schema-validator';
import { Agent, Runner, tool, OpenAIProvider } from '@openai/agents';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAzure } from '@ai-sdk/azure';
import { createCohere } from '@ai-sdk/cohere';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import OpenAI from 'openai';
import { z } from 'zod';

// TypeScript's legacy Node resolution cannot resolve this package export.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { aisdk } = require('@openai/agents-extensions/ai-sdk') as { aisdk: (model: any) => any };

function createAiSdkLanguageModel(pc: ProviderTestCase): any {
  const fetch = mockFetchJson(pc.chatResponse);
  switch (pc.name) {
    case ProviderName.OPENAI:
      return createOpenAI({ apiKey: FAKE_OPENAI_KEY, fetch }).chat(pc.expectedModel);
    case ProviderName.ANTHROPIC:
      return createAnthropic({ apiKey: FAKE_ANTHROPIC_KEY, fetch })(pc.expectedModel);
    case ProviderName.GOOGLE:
      return createGoogleGenerativeAI({ apiKey: FAKE_GOOGLE_KEY, fetch })(pc.expectedModel);
    case ProviderName.GROQ:
      return createGroq({ apiKey: FAKE_GROQ_KEY, fetch })(pc.expectedModel);
    case ProviderName.MISTRAL:
      return createMistral({ apiKey: FAKE_MISTRAL_KEY, fetch }).chat(pc.expectedModel);
    case ProviderName.COHERE:
      return createCohere({ apiKey: FAKE_COHERE_KEY, fetch })(pc.expectedModel);
    case ProviderName.XAI:
      return createXai({ apiKey: FAKE_XAI_KEY, fetch }).chat(pc.expectedModel);
    default:
      throw new Error(`Unsupported AI-SDK provider test case: ${pc.name}`);
  }
}

function createRunner(
  responses: Record<string, unknown>[],
  statusCode: number = 200,
  useResponses: boolean = true
): Runner {
  let callIndex = 0;
  const client = new OpenAI({
    apiKey: FAKE_OPENAI_KEY,
    fetch: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return new Response(JSON.stringify(response), {
        status: statusCode,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const provider = new OpenAIProvider({ openAIClient: client, useResponses });
  return new Runner({ modelProvider: provider, tracingDisabled: false });
}

function setCaptureContent(enabled: boolean): void {
  const processor = instrumentation._processor as any;
  if (processor) {
    processor._captureMessageContent = enabled;
  }
}

function expectNoOpenAiAttributes(span: ReadableSpan): void {
  expect(Object.keys(span.attributes).filter(key => key.startsWith('open_ai.'))).toEqual([]);
}

describe('OpenAI Agents Instrumentation', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMemoryExporter();
    setCaptureContent(true);
  });

  describe('agent spans', function () {
    it('creates an invoke_agent span with correct attributes', async () => {
      const agent = new Agent({
        name: 'TestAgent',
        instructions: 'You are a test agent.',
        model: OPENAI_MODEL,
      });

      const runner = createRunner([OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'What is the capital of France?');

      const spans = getTestSpans();
      const agentSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
      expect(agentSpan).toBeDefined();
      expect(agentSpan!.name).toBe('invoke_agent TestAgent');
      expect(agentSpan!.kind).toBe(SpanKind.INTERNAL);
      expect(agentSpan!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_NAME_VALUE_OPENAI);
      expect(agentSpan!.attributes[ATTR_GEN_AI_AGENT_NAME]).toBe('TestAgent');
      expect(agentSpan!.attributes[ATTR_GEN_AI_OUTPUT_TYPE]).toBe('text');
      expectNoOpenAiAttributes(agentSpan!);
    });

    it('propagates model from child response to parent agent', async () => {
      const agent = new Agent({
        name: 'MyAgent',
        instructions: 'Be helpful.',
        model: OPENAI_MODEL,
      });

      const runner = createRunner([OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'Hello');

      const spans = getTestSpans();
      const agentSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
      expect(agentSpan).toBeDefined();
      expect(agentSpan!.attributes[ATTR_GEN_AI_RESPONSE_MODEL]).toBe('gpt-4o-mini-2024-07-18');
    });

    it('captures the first user message and final response on the parent agent', async () => {
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      });
      const agent = new Agent({
        name: 'ConversationAgent',
        instructions: 'Use tools when needed.',
        model: OPENAI_MODEL,
        tools: [getWeather],
      });

      const runner = createRunner([OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE, OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'Weather in Tokyo?');

      const agentSpan = getTestSpans().find(
        (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent'
      );
      expect(agentSpan).toBeDefined();

      const inputMessages = JSON.parse(agentSpan!.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
      await validateOtelGenaiSchema(inputMessages, 'gen-ai-input-messages');
      expect(inputMessages).toEqual([
        {
          role: 'user',
          parts: [{ type: 'text', content: 'Weather in Tokyo?' }],
        },
      ]);

      const outputMessages = JSON.parse(agentSpan!.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
      await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
      expect(outputMessages).toEqual([
        {
          role: 'assistant',
          parts: [{ type: 'text', content: 'Paris is the capital of France.' }],
          finish_reason: 'stop',
        },
      ]);
    });

    it('does not propagate model or messages to a non-agent parent', function () {
      const processor = new OpenTelemetryTracingProcessor(
        trace.getTracer('openai-agents-parent-type-test'),
        true
      ) as any;
      const setAttribute = sinon.spy();
      processor._spanMap.set('response-parent', {
        otelSpan: { isRecording: () => true, setAttribute },
        otelContext: undefined,
      });

      processor._propagateModelToAgent('response-parent', OPENAI_MODEL);
      processor._propagateMessagesToAgent(
        'response-parent',
        JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'Hello' }] }]),
        JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Hi' }], finish_reason: 'stop' }])
      );

      expect(setAttribute.called).toBe(false);
    });

    it('supports task and turn spans from newer OpenAI Agents SDK versions', async () => {
      const processor = new OpenTelemetryTracingProcessor(
        trace.getTracer('openai-agents-task-turn-compatibility-test'),
        true
      );
      const taskSpan = {
        spanId: 'task-span',
        parentId: null,
        spanData: {
          type: 'task',
          name: 'Order workflow',
          usage: {
            input_tokens: 42,
            output_tokens: 9,
            cached_input_tokens: 7,
            cache_write_input_tokens: 3,
            requests: 1,
            total_tokens: 51,
          },
        },
        error: null,
      };
      const agentSpan = {
        spanId: 'agent-span',
        parentId: taskSpan.spanId,
        spanData: {
          type: 'agent',
          name: 'OrderAgent',
          handoffs: ['ReturnsAgent'],
          tools: ['get_order'],
          output_type: 'text',
        },
        error: null,
      };
      const turnSpan = {
        spanId: 'turn-span',
        parentId: agentSpan.spanId,
        spanData: {
          type: 'turn',
          turn: 1,
          agent_name: 'OrderAgent',
          usage: {
            input_tokens: 42,
            output_tokens: 9,
            cached_input_tokens: 7,
            cache_write_input_tokens: 3,
          },
        },
        error: null,
      };
      const generationSpan = {
        spanId: 'generation-span',
        parentId: turnSpan.spanId,
        spanData: {
          type: 'generation',
          model: 'amazon-bedrock:test-model',
          model_config: { provider: 'amazon-bedrock' },
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Where is my order?' }] }],
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Your order has shipped.' }],
            },
          ],
          usage: { input_tokens: 42, output_tokens: 9 },
        },
        error: null,
      };

      await processor.onSpanStart(taskSpan as any);
      await processor.onSpanStart(agentSpan as any);
      await processor.onSpanStart(turnSpan as any);
      await processor.onSpanStart(generationSpan as any);
      await processor.onSpanEnd(generationSpan as any);
      await processor.onSpanEnd(turnSpan as any);
      await processor.onSpanEnd(agentSpan as any);
      await processor.onSpanEnd(taskSpan as any);

      const spans = getTestSpans();
      const exportedAgentSpan = spans.find(span => span.name === 'invoke_agent OrderAgent');
      const exportedTurnSpan = spans.find(span => span.name === 'turn');
      const exportedTaskSpan = spans.find(span => span.name === 'task Order workflow');
      expect(exportedAgentSpan).toBeDefined();
      expect(exportedTurnSpan).toBeDefined();
      expect(exportedTaskSpan).toBeDefined();

      expect(exportedAgentSpan!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK);
      expect(exportedAgentSpan!.attributes[ATTR_GEN_AI_RESPONSE_MODEL]).toBe('test-model');
      expect(exportedTurnSpan!.attributes[ATTR_GEN_AI_AGENT_NAME]).toBe('OrderAgent');
      for (const span of [exportedTurnSpan!, exportedTaskSpan!]) {
        expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(42);
        expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(9);
        expect(span.attributes[ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(7);
        expect(span.attributes[ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(3);
      }

      const inputMessages = JSON.parse(exportedAgentSpan!.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
      await validateOtelGenaiSchema(inputMessages, 'gen-ai-input-messages');
      expect(inputMessages).toEqual([
        {
          role: 'user',
          parts: [{ type: 'text', content: 'Where is my order?' }],
        },
      ]);

      const outputMessages = JSON.parse(exportedAgentSpan!.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
      await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
      expect(outputMessages).toEqual([
        {
          role: 'assistant',
          parts: [{ type: 'text', content: 'Your order has shipped.' }],
          finish_reason: 'stop',
        },
      ]);

      for (const span of spans) {
        expectNoOpenAiAttributes(span);
      }
    });
  });

  describe('response spans', function () {
    it('creates a chat span with usage attributes', async () => {
      const agent = new Agent({
        name: 'ChatAgent',
        instructions: 'You are helpful.',
        model: OPENAI_MODEL,
      });

      const runner = createRunner([OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'What is the capital of France?');

      const spans = getTestSpans();
      const chatSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpan).toBeDefined();
      expect(chatSpan!.kind).toBe(SpanKind.CLIENT);
      expect(chatSpan!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_NAME_VALUE_OPENAI);
      expect(chatSpan!.attributes[ATTR_GEN_AI_RESPONSE_ID]).toBe('resp_abc123');
      expect(chatSpan!.attributes[ATTR_GEN_AI_RESPONSE_MODEL]).toBe('gpt-4o-mini-2024-07-18');
      expect(chatSpan!.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(18);
      expect(chatSpan!.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(8);
    });

    it('maps stop finish reason from message output', async () => {
      const agent = new Agent({
        name: 'Agent',
        instructions: 'Be helpful.',
        model: OPENAI_MODEL,
      });

      const runner = createRunner([OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'Hello');

      const spans = getTestSpans();
      const chatSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpan).toBeDefined();
      expect(chatSpan!.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
    });

    it('maps tool_calls finish reason from function_call output', async () => {
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      });

      const agent = new Agent({
        name: 'ToolAgent',
        instructions: 'Use tools.',
        model: OPENAI_MODEL,
        tools: [getWeather],
      });

      const runner = createRunner([OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE, OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'Weather in Tokyo?');

      const spans = getTestSpans();
      const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      const toolCallSpan = chatSpans.find((s: ReadableSpan) =>
        (s.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] as string[] | undefined)?.includes('tool_call')
      );
      expect(toolCallSpan).toBeDefined();
    });
  });

  describe('generation spans', function () {
    const compoundProviderCases = [
      { name: ProviderName.OPENAI, rawProvider: 'openai.chat' },
      { name: ProviderName.ANTHROPIC, rawProvider: 'anthropic.messages' },
      { name: ProviderName.GOOGLE, rawProvider: 'google.generative-ai' },
      { name: ProviderName.GROQ, rawProvider: 'groq.chat' },
      { name: ProviderName.MISTRAL, rawProvider: 'mistral.chat' },
      { name: ProviderName.COHERE, rawProvider: 'cohere.chat' },
      { name: ProviderName.XAI, rawProvider: 'xai.chat' },
    ];

    it('translates Bedrock AI-SDK generation spans to GenAI attributes', async () => {
      const bedrockCase = getProviderCases().find(pc => pc.name === ProviderName.BEDROCK)!;
      let callIndex = 0;
      const provider = createAmazonBedrock({
        region: AWS_REGION,
        accessKeyId: FAKE_AWS_ACCESS_KEY_ID,
        secretAccessKey: FAKE_AWS_SECRET_ACCESS_KEY,
        fetch: async () => {
          const response = callIndex++ === 0 ? bedrockCase.toolCallResponse : bedrockCase.chatResponse;
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      const getWeather = tool({
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: z.object({ location: z.string() }),
        execute: async ({ location }) => `Sunny in ${location}`,
      });
      const agent = new Agent({
        name: 'BedrockAgent',
        instructions: 'Use the weather tool when needed.',
        model: aisdk(provider(BEDROCK_MODEL)),
        tools: [getWeather],
      });

      await new Runner({ tracingDisabled: false }).run(agent, 'What is the weather in Tokyo?');

      const generationSpans = getTestSpans().filter(
        (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
      );
      expect(generationSpans).toHaveLength(2);

      for (const span of generationSpans) {
        expect(span.name).toBe(`chat ${BEDROCK_MODEL}`);
        expect(span.kind).toBe(SpanKind.CLIENT);
        expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK);
        expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(BEDROCK_MODEL);
        expect(span.attributes['open_ai.generation.model']).toBeUndefined();
        expect(span.attributes['open_ai.generation.input']).toBeUndefined();
        expect(span.attributes['open_ai.generation.output']).toBeUndefined();
        expect(span.attributes['open_ai.generation.usage']).toBeUndefined();
        expect(span.attributes['open_ai.generation.model_config']).toBeUndefined();
      }

      const toolCallSpan = generationSpans.find(span =>
        (span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] as string[] | undefined)?.includes('tool_call')
      );
      expect(toolCallSpan).toBeDefined();
      expect(toolCallSpan!.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(40);
      expect(toolCallSpan!.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(20);
      const toolCallOutput = JSON.parse(toolCallSpan!.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
      expect(toolCallOutput[0].parts).toContainEqual({
        type: 'tool_call',
        id: 'call_bedrock_001',
        name: 'get_weather',
        arguments: { location: 'Tokyo' },
      });

      const finalSpan = generationSpans.find(
        span => (span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] as string[] | undefined)?.[0] === 'stop'
      );
      expect(finalSpan).toBeDefined();
      expect(finalSpan!.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(18);
      expect(finalSpan!.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(8);
      const finalInput = JSON.parse(finalSpan!.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
      expect(finalInput.flatMap((message: any) => message.parts)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool_call', id: 'call_bedrock_001', name: 'get_weather' }),
          expect.objectContaining({ type: 'tool_call_response', id: 'call_bedrock_001' }),
        ])
      );

      const agentSpan = getTestSpans().find(
        (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent'
      );
      expect(agentSpan).toBeDefined();
      expect(agentSpan!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK);
      expectNoOpenAiAttributes(agentSpan!);
      const agentInput = JSON.parse(agentSpan!.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
      expect(agentInput).toEqual([
        {
          role: 'user',
          parts: [{ type: 'text', content: 'What is the weather in Tokyo?' }],
        },
      ]);
      const agentOutput = JSON.parse(agentSpan!.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
      expect(agentOutput[0]).toEqual(
        expect.objectContaining({
          role: 'assistant',
          finish_reason: 'stop',
        })
      );
      expect(agentOutput[0].parts).toContainEqual({
        type: 'text',
        content: 'Paris is the capital of France.',
      });
    });

    for (const { name, rawProvider } of compoundProviderCases) {
      it(`resolves ${rawProvider} generation spans`, async () => {
        const providerCase = getProviderCases().find(pc => pc.name === name)!;
        const languageModel = createAiSdkLanguageModel(providerCase);
        expect(languageModel.provider).toBe(rawProvider);

        const agent = new Agent({
          name: `${name}Agent`,
          instructions: 'Be helpful.',
          model: aisdk(languageModel),
        });
        await new Runner({ tracingDisabled: false }).run(agent, 'What is the capital of France?');

        const generationSpan = getTestSpans().find(
          (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
        );
        expect(generationSpan).toBeDefined();
        expect(generationSpan!.name).toBe(`chat ${providerCase.expectedModel}`);
        expect(generationSpan!.kind).toBe(SpanKind.CLIENT);
        expect(generationSpan!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(providerCase.expectedProvider);
        expect(generationSpan!.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(providerCase.expectedModel);

        const agentSpan = getTestSpans().find(
          (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent'
        );
        expect(agentSpan).toBeDefined();
        expect(agentSpan!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(providerCase.expectedProvider);
      });
    }

    it('resolves azure.chat generation spans', async () => {
      const openaiCase = getProviderCases().find(pc => pc.name === ProviderName.OPENAI)!;
      const languageModel = createAzure({
        apiKey: FAKE_OPENAI_KEY,
        resourceName: 'test-resource',
        fetch: mockFetchJson(openaiCase.chatResponse),
      }).chat(openaiCase.expectedModel);
      expect(languageModel.provider).toBe('azure.chat');

      const agent = new Agent({
        name: 'AzureAgent',
        instructions: 'Be helpful.',
        model: aisdk(languageModel),
      });
      await new Runner({ tracingDisabled: false }).run(agent, 'What is the capital of France?');

      const generationSpan = getTestSpans().find(
        (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
      );
      expect(generationSpan).toBeDefined();
      expect(generationSpan!.name).toBe(`chat ${openaiCase.expectedModel}`);
      expect(generationSpan!.kind).toBe(SpanKind.CLIENT);
      expect(generationSpan!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI);
      expect(generationSpan!.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(openaiCase.expectedModel);

      const agentSpan = getTestSpans().find(
        (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent'
      );
      expect(agentSpan).toBeDefined();
      expect(agentSpan!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI);
    });

    it('keeps OpenAI defaults for a native Chat Completions generation span', async () => {
      const openaiCase = getProviderCases().find(pc => pc.name === ProviderName.OPENAI)!;
      const agent = new Agent({
        name: 'ChatCompletionsAgent',
        instructions: 'Be helpful.',
        model: 'gpt-4o',
        modelSettings: {
          temperature: 0.4,
          topP: 0.8,
        },
      });

      await createRunner([openaiCase.chatResponse], 200, false).run(agent, 'Hello');

      const generationSpan = getTestSpans().find(
        (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
      );
      expect(generationSpan).toBeDefined();
      expect(generationSpan!.name).toBe('chat gpt-4o');
      expect(generationSpan!.kind).toBe(SpanKind.CLIENT);
      expect(generationSpan!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(GEN_AI_PROVIDER_NAME_VALUE_OPENAI);
      expect(generationSpan!.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe('gpt-4o');
      expect(generationSpan!.attributes[ATTR_GEN_AI_REQUEST_TEMPERATURE]).toBe(0.4);
      expect(generationSpan!.attributes[ATTR_GEN_AI_REQUEST_TOP_P]).toBe(0.8);
    });
  });

  describe('function spans', function () {
    it('creates an execute_tool span with correct attributes', async () => {
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      });

      const agent = new Agent({
        name: 'ToolAgent',
        instructions: 'Use tools when asked.',
        model: OPENAI_MODEL,
        tools: [getWeather],
      });

      const runner = createRunner([OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE, OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'Weather in Tokyo?');

      const spans = getTestSpans();
      const toolSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool');
      expect(toolSpan).toBeDefined();
      expect(toolSpan!.name).toBe('execute_tool get_weather');
      expect(toolSpan!.kind).toBe(SpanKind.INTERNAL);
      expect(toolSpan!.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('get_weather');
      expect(toolSpan!.attributes[ATTR_GEN_AI_TOOL_TYPE]).toBe('function');
      expect(toolSpan!.attributes[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]).toBe('{"city":"Tokyo"}');
      expect(toolSpan!.attributes[ATTR_GEN_AI_TOOL_CALL_RESULT]).toBe('Sunny in Tokyo');
    });

    it('omits an empty SDK placeholder result from a real Runner tool span', async () => {
      const emptyTool = tool({
        name: 'empty_tool',
        description: 'Return an empty result',
        parameters: z.object({}),
        execute: async () => '',
      });
      const agent = new Agent({
        name: 'EmptyToolAgent',
        instructions: 'Use the empty tool.',
        model: OPENAI_MODEL,
        tools: [emptyTool],
      });
      const toolCallResponse = {
        ...OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE,
        output: [
          {
            type: 'function_call',
            id: 'fc_empty',
            call_id: 'call_empty',
            name: 'empty_tool',
            arguments: '{}',
            status: 'completed',
          },
        ],
      };

      await createRunner([toolCallResponse, OPENAI_RESPONSES_API_CHAT_RESPONSE]).run(agent, 'Run the empty tool');

      const toolSpan = getTestSpans().find(
        (span: ReadableSpan) => span.attributes[ATTR_GEN_AI_TOOL_NAME] === 'empty_tool'
      );
      expect(toolSpan).toBeDefined();
      expect(toolSpan!.attributes[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]).toBe('{}');
      expect(toolSpan!.attributes[ATTR_GEN_AI_TOOL_CALL_RESULT]).toBeUndefined();
    });

    it('does not capture tool arguments/result when captureMessageContent is false', async () => {
      setCaptureContent(false);

      const getWeather = tool({
        name: 'get_weather',
        description: 'Get weather',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      });

      const agent = new Agent({
        name: 'ToolAgent',
        instructions: 'Use tools.',
        model: OPENAI_MODEL,
        tools: [getWeather],
      });

      const runner = createRunner([OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE, OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'Weather?');

      const spans = getTestSpans();
      const toolSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool');
      expect(toolSpan).toBeDefined();
      expect(toolSpan!.attributes[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]).toBeUndefined();
      expect(toolSpan!.attributes[ATTR_GEN_AI_TOOL_CALL_RESULT]).toBeUndefined();
    });
  });

  describe('content capture', function () {
    it('captures input and output messages when enabled', async () => {
      const agent = new Agent({
        name: 'ContentAgent',
        instructions: 'You are helpful.',
        model: OPENAI_MODEL,
      });

      const runner = createRunner([
        {
          ...OPENAI_RESPONSES_API_CHAT_RESPONSE,
          instructions: 'You are helpful.',
          output: [
            {
              type: 'message',
              id: 'msg_001',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'The answer is 4' }],
            },
          ],
        },
      ]);
      await runner.run(agent, 'What is 2+2?');

      const spans = getTestSpans();
      const chatSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpan).toBeDefined();

      const sysInstr = chatSpan!.attributes[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS] as string | undefined;
      expect(sysInstr).toBeDefined();
      const parsedInstr = JSON.parse(sysInstr!);
      expect(parsedInstr[0].content).toBe('You are helpful.');

      const inputMsgs = chatSpan!.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string | undefined;
      expect(inputMsgs).toBeDefined();
      const parsedInput = JSON.parse(inputMsgs!);
      await validateOtelGenaiSchema(parsedInput, 'gen-ai-input-messages');

      const outputMsgs = chatSpan!.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string | undefined;
      expect(outputMsgs).toBeDefined();
      const parsedOutput = JSON.parse(outputMsgs!);
      await validateOtelGenaiSchema(parsedOutput, 'gen-ai-output-messages');
      expect(parsedOutput[0].role).toBe('assistant');
      expect(parsedOutput[0].parts[0].content).toBe('The answer is 4');
    });

    it('normalizes Responses API text, image, refusal, and reasoning blocks', function () {
      const processor = new OpenTelemetryTracingProcessor(trace.getTracer('openai-agents-content-test'), true) as any;
      expect(
        processor._formatMessageParts([
          { type: 'input_text', text: 'describe' },
          { type: 'input_image', image: 'data:image/png;base64,AAAA' },
        ])
      ).toEqual([
        { type: 'text', content: 'describe' },
        { type: 'blob', modality: 'image', content: 'AAAA', mime_type: 'image/png' },
      ]);

      const outputMessages = JSON.parse(
        processor._formatOutputMessages(
          [
            {
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'A concise reasoning summary.' }],
            },
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'The answer is blue.' },
                { type: 'refusal', refusal: 'I cannot provide another detail.' },
              ],
            },
          ],
          ['stop']
        )
      );
      expect(outputMessages[0].parts).toEqual([
        { type: 'reasoning', content: 'A concise reasoning summary.' },
        { type: 'text', content: 'The answer is blue.' },
        { type: 'refusal', refusal: 'I cannot provide another detail.' },
      ]);
    });

    it('normalizes AI-SDK reasoning, file, and tool content', function () {
      const processor = new OpenTelemetryTracingProcessor(
        trace.getTracer('openai-agents-ai-sdk-content-test'),
        true
      ) as any;
      expect(
        processor._formatMessageParts([
          { type: 'reasoning', text: 'Use the weather tool.' },
          { type: 'file', data: 'AAAA', mediaType: 'image/png' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Seattle' } },
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            output: { type: 'json', value: { forecast: 'rain' } },
          },
        ])
      ).toEqual([
        { type: 'reasoning', content: 'Use the weather tool.' },
        { type: 'blob', modality: 'image', mime_type: 'image/png', content: 'AAAA' },
        { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: { city: 'Seattle' } },
        {
          type: 'tool_call_response',
          id: 'call_1',
          response: { type: 'json', value: { forecast: 'rain' } },
        },
      ]);

      const outputMessages = JSON.parse(
        processor._formatOutputMessages(
          [
            {
              type: 'reasoning',
              content: [],
              rawContent: [{ type: 'reasoning_text', text: 'Raw provider reasoning.' }],
            },
          ],
          ['stop']
        )
      );
      expect(outputMessages[0].parts).toEqual([{ type: 'reasoning', content: 'Raw provider reasoning.' }]);
    });

    it('maps incomplete response details to canonical finish reasons', function () {
      const processor = new OpenTelemetryTracingProcessor(trace.getTracer('openai-agents-finish-test'), true) as any;
      expect(processor._getFinishReasons({ incomplete_details: { reason: 'max_output_tokens' } })).toEqual(['length']);
      expect(processor._getFinishReasons({ incomplete_details: { reason: 'content_filter' } })).toEqual([
        'content_filter',
      ]);
      expect(processor._getFinishReasons({ status: 'failed' })).toEqual(['error']);
    });

    it('does not capture messages when disabled', async () => {
      setCaptureContent(false);

      const agent = new Agent({
        name: 'NoContentAgent',
        instructions: 'Be helpful.',
        model: OPENAI_MODEL,
      });

      const runner = createRunner([OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'Hello');

      const spans = getTestSpans();
      const chatSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      const agentSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
      expect(chatSpan).toBeDefined();
      expect(agentSpan).toBeDefined();
      expect(chatSpan!.attributes[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeUndefined();
      expect(chatSpan!.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeUndefined();
      expect(chatSpan!.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
      expect(agentSpan!.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeUndefined();
      expect(agentSpan!.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
    });
  });

  describe('parent-child relationships', function () {
    it('creates correct parent-child hierarchy for agent > response > function', async () => {
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get weather',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      });

      const agent = new Agent({
        name: 'ParentChildAgent',
        instructions: 'Use tools when asked.',
        model: OPENAI_MODEL,
        tools: [getWeather],
      });

      const runner = createRunner([OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE, OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'Weather in Tokyo?');

      const spans = getTestSpans();
      const agentSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
      const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      const toolSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool');

      expect(agentSpan).toBeDefined();
      expect(chatSpans.length).toBeGreaterThanOrEqual(1);
      expect(toolSpan).toBeDefined();

      const agentSpanId = agentSpan!.spanContext().spanId;
      const agentTraceId = agentSpan!.spanContext().traceId;

      for (const chatSpan of chatSpans) {
        expect(chatSpan.parentSpanContext?.spanId).toBe(agentSpanId);
        expect(chatSpan.spanContext().traceId).toBe(agentTraceId);
      }

      expect(toolSpan!.parentSpanContext?.spanId).toBe(agentSpanId);
      expect(toolSpan!.spanContext().traceId).toBe(agentTraceId);
    });
  });

  describe('error handling', function () {
    it('records error status on model failure', async () => {
      const agent = new Agent({
        name: 'ErrorAgent',
        instructions: 'Be helpful.',
        model: OPENAI_MODEL,
      });

      const runner = createRunner([OPENAI_RESPONSES_API_ERROR_RESPONSE], 500);

      try {
        await runner.run(agent, 'Hello');
      } catch {
        // expected
      }

      const spans = getTestSpans();
      const errorSpans = spans.filter((s: ReadableSpan) => s.status.code === SpanStatusCode.ERROR);
      expect(errorSpans.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('multiple tool calls', function () {
    it('creates spans for agent with multiple tools', async () => {
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      });

      const getTime = tool({
        name: 'get_time',
        description: 'Get current time in a timezone',
        parameters: z.object({ timezone: z.string() }),
        execute: async ({ timezone }) => `12:00 PM ${timezone}`,
      });

      const agent = new Agent({
        name: 'MultiToolAgent',
        instructions: 'Use the appropriate tools.',
        model: OPENAI_MODEL,
        tools: [getWeather, getTime],
      });

      const runner = createRunner([OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE, OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      await runner.run(agent, 'Weather in Tokyo?');

      const spans = getTestSpans();
      const agentSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
      const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      const toolSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool');

      expect(agentSpan).toBeDefined();
      expect(chatSpans.length).toBe(2);
      expect(toolSpans.length).toBe(1);
      expect(toolSpans[0].attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('get_weather');
      expect(toolSpans[0].attributes[ATTR_GEN_AI_TOOL_CALL_RESULT]).toBe('Sunny in Tokyo');
    });
  });

  describe('tool definitions', function () {
    it('captures tool definitions on chat spans', async () => {
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      });

      const agent = new Agent({
        name: 'ToolDefAgent',
        instructions: 'Use tools.',
        model: OPENAI_MODEL,
        tools: [getWeather],
      });

      const runner = createRunner([OPENAI_RESPONSES_API_CHAT_RESPONSE_WITH_TOOLS]);
      await runner.run(agent, 'Weather in Tokyo?');

      const spans = getTestSpans();
      const chatSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpan).toBeDefined();

      const toolDefs = chatSpan!.attributes[ATTR_GEN_AI_TOOL_DEFINITIONS] as string | undefined;
      expect(toolDefs).toBeDefined();
      const parsed = JSON.parse(toolDefs!);
      expect(Array.isArray(parsed)).toBe(true);
      const def = parsed.find((t: any) => t.name === 'get_weather');
      expect(def).toBeDefined();
      expect(def.type).toBe('function');
      expect(def.description).toBe('Get weather for a city');
    });
  });

  describe('request parameters', function () {
    it('captures temperature and top_p from response', async () => {
      const agent = new Agent({
        name: 'ParamAgent',
        instructions: 'Be helpful.',
        model: OPENAI_MODEL,
      });

      const runner = createRunner([
        {
          ...OPENAI_RESPONSES_API_CHAT_RESPONSE,
          temperature: 0.7,
          top_p: 0.9,
        },
      ]);
      await runner.run(agent, 'Hello');

      const spans = getTestSpans();
      const chatSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpan).toBeDefined();
      expect(chatSpan!.attributes[ATTR_GEN_AI_REQUEST_TEMPERATURE]).toBe(0.7);
      expect(chatSpan!.attributes[ATTR_GEN_AI_REQUEST_TOP_P]).toBe(0.9);
    });
  });

  describe('system instructions schema', function () {
    it('validates system instructions against OTel GenAI schema', async () => {
      const agent = new Agent({
        name: 'SchemaAgent',
        instructions: 'You are a helpful assistant.',
        model: OPENAI_MODEL,
      });

      const runner = createRunner([
        {
          ...OPENAI_RESPONSES_API_CHAT_RESPONSE,
          instructions: 'You are a helpful assistant.',
        },
      ]);
      await runner.run(agent, 'Hello');

      const spans = getTestSpans();
      const chatSpan = spans.find((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
      expect(chatSpan).toBeDefined();

      const sysInstr = chatSpan!.attributes[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS] as string | undefined;
      expect(sysInstr).toBeDefined();
      const parsed = JSON.parse(sysInstr!);
      await validateOtelGenaiSchema(parsed, 'gen-ai-system-instructions');
      expect(parsed[0].content).toBe('You are a helpful assistant.');
    });
  });

  describe('tool execution error', function () {
    it('records error when tool execution fails', async () => {
      const failingTool = tool({
        name: 'failing_tool',
        description: 'A tool that fails',
        parameters: z.object({ input: z.string() }),
        execute: async () => {
          throw new Error('Tool execution failed');
        },
      });

      const agent = new Agent({
        name: 'ErrorToolAgent',
        instructions: 'Use tools.',
        model: OPENAI_MODEL,
        tools: [failingTool],
      });

      const runner = createRunner([OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE, OPENAI_RESPONSES_API_CHAT_RESPONSE]);
      try {
        await runner.run(agent, 'Do something');
      } catch {
        // expected
      }

      const spans = getTestSpans();
      const errorSpans = spans.filter((s: ReadableSpan) => s.status.code === SpanStatusCode.ERROR);
      expect(errorSpans.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('enable override', () => {
    afterEach(() => {
      delete process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS;
      delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
      delete process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN;
    });

    it('skips enable when disabled via OTEL_NODE_DISABLED_INSTRUMENTATIONS', () => {
      process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'aws_openai_agents';
      const instr = new OpenAIAgentsInstrumentation();
      const superEnable = sinon.spy(Object.getPrototypeOf(OpenAIAgentsInstrumentation.prototype), 'enable');
      instr.enable();
      expect(superEnable.called).toBeFalsy();
      superEnable.restore();
    });

    it('skips enable when not in OTEL_NODE_ENABLED_INSTRUMENTATIONS', () => {
      process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = 'http,aws-sdk';
      const instr = new OpenAIAgentsInstrumentation();
      const superEnable = sinon.spy(Object.getPrototypeOf(OpenAIAgentsInstrumentation.prototype), 'enable');
      instr.enable();
      expect(superEnable.called).toBeFalsy();
      superEnable.restore();
    });

    it('calls super.enable when not disabled and no conflicts', () => {
      const instr = new OpenAIAgentsInstrumentation();
      const superEnable = sinon.spy(Object.getPrototypeOf(OpenAIAgentsInstrumentation.prototype), 'enable');
      instr.enable();
      expect(superEnable.called).toBeTruthy();
      superEnable.restore();
    });
  });
});
