// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { instrumentation, contentCaptureInstrumentation } from './load-instrumentation';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { SpanKind, SpanStatusCode, trace, Context as OtelContext } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_REQUEST_STOP_SEQUENCES,
  ATTR_GEN_AI_REQUEST_TOP_K,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
} from '../../../src/instrumentation/common/semconv';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { expect } from 'expect';
import * as nock from 'nock';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatMistralAI } from '@langchain/mistralai';
import { ChatGroq } from '@langchain/groq';
import { ChatCohere } from '@langchain/cohere';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatXAI } from '@langchain/xai';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { FakeListChatModel, FakeLLM } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { RunnableLambda } from '@langchain/core/runnables';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createReactAgent } = require('@langchain/langgraph/prebuilt');
import { z } from 'zod';
import type { ChatResult } from '@langchain/core/outputs';
import {
  BEDROCK_CHAT_RESPONSE,
  BEDROCK_TOOL_CALL_RESPONSE,
  OPENAI_CHAT_RESPONSE,
  OPENAI_TOOL_CALL_RESPONSE,
  OPENAI_ERROR_RESPONSE,
  ANTHROPIC_CHAT_RESPONSE,
  ANTHROPIC_TOOL_CALL_RESPONSE,
  BEDROCK_ERROR_RESPONSE,
  ANTHROPIC_ERROR_RESPONSE,
} from '../mock-responses';
import { validateOtelGenaiSchema } from '../otel-schema-validator';
import { OpenTelemetryCallbackHandler } from '../../../src/instrumentation/instrumentation-langchain/callback-handler';
import { LangChainInstrumentation } from '../../../src/instrumentation/instrumentation-langchain/instrumentation';

const REGION = 'us-east-1';
const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const OPENAI_MODEL = 'gpt-4o-mini';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const FAKE_OPENAI_KEY = 'sk-test1234567890abcdef1234567890abcdef1234567890abcdef';
const FAKE_ANTHROPIC_KEY = 'sk-ant-test1234567890abcdef1234567890abcdef';

type Provider = 'bedrock' | 'openai' | 'anthropic';

function createModel(
  provider: Provider,
  opts: Record<string, unknown> = {}
): ChatBedrockConverse | ChatOpenAI | ChatAnthropic {
  switch (provider) {
    case 'bedrock': {
      const client = new BedrockRuntimeClient({
        region: REGION,
        credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
        requestHandler: new NodeHttpHandler(),
      });
      return new ChatBedrockConverse({ model: BEDROCK_MODEL_ID, region: REGION, client, ...opts });
    }
    case 'openai':
      return new ChatOpenAI({
        model: OPENAI_MODEL,
        apiKey: FAKE_OPENAI_KEY,
        temperature: 0.7,
        maxTokens: 256,
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        configuration: { fetch: require('node-fetch') },
        ...opts,
      });
    case 'anthropic':
      return new ChatAnthropic({
        anthropicApiKey: FAKE_ANTHROPIC_KEY,
        modelName: ANTHROPIC_MODEL,
        temperature: 0.5,
        topK: 40,
        maxTokens: 256,
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        clientOptions: { fetch: require('node-fetch') },
        ...opts,
      });
  }
}

function nockProvider(provider: Provider, response: Record<string, unknown>, statusCode: number = 200): nock.Scope {
  switch (provider) {
    case 'bedrock':
      return nock(`https://bedrock-runtime.${REGION}.amazonaws.com`)
        .post(/.*/)
        .reply(statusCode, JSON.stringify(response), {
          'content-type': 'application/json',
          'x-amzn-requestid': 'req-bedrock-1234',
        });
    case 'openai':
      return nock('https://api.openai.com')
        .post('/v1/chat/completions')
        .reply(statusCode, response, { 'content-type': 'application/json' });
    case 'anthropic':
      return nock('https://api.anthropic.com')
        .post('/v1/messages')
        .reply(statusCode, response, { 'content-type': 'application/json' });
  }
}

function makeFakeChatResult(): ChatResult {
  return {
    generations: [
      {
        message: new AIMessage({
          content: 'ok',
          response_metadata: { finish_reason: 'stop' },
          usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        text: 'ok',
        generationInfo: { finish_reason: 'stop' },
      },
    ],
    llmOutput: {
      model_name: 'test',
      token_usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  };
}

function stubGenerate(model: BaseChatModel): () => void {
  const proto = Object.getPrototypeOf(model);
  const original = proto._generate;
  proto._generate = async function (): Promise<ChatResult> {
    return makeFakeChatResult();
  };
  return () => {
    proto._generate = original;
  };
}

describe('ChatBedrockConverse, ChatOpenAI & ChatAnthropic', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
    nock.cleanAll();
  });

  afterEach(() => {
    instrumentation.disable();
    contentCaptureInstrumentation.disable();
    nock.cleanAll();
  });

  it('creates a Bedrock chat span with correct attributes', async () => {
    instrumentation.enable();
    nockProvider('bedrock', BEDROCK_CHAT_RESPONSE);

    const model = createModel('bedrock');
    const result = await model.invoke([new HumanMessage('What is the capital of France?')]);

    expect(result.content).toBe('Paris is the capital of France.');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.name).toContain(`chat ${BEDROCK_MODEL_ID}`);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('aws.bedrock');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(BEDROCK_MODEL_ID);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(25);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_ID]).toBe('req-bedrock-1234');
  });

  it('creates an OpenAI chat span with correct attributes', async () => {
    instrumentation.enable();
    nockProvider('openai', OPENAI_CHAT_RESPONSE);

    const model = createModel('openai', {
      topP: 0.9,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
      stop: ['END'],
    });
    const result = await model.invoke([new HumanMessage('What is the capital of France?')]);

    expect(result.content).toBe('Paris is the capital of France.');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.name).toContain(`chat ${OPENAI_MODEL}`);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('openai');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(OPENAI_MODEL);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(18);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(8);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_ID]).toBe('chatcmpl-abc123');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_TEMPERATURE]).toBe(0.7);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MAX_TOKENS]).toBe(256);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_TOP_P]).toBe(0.9);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY]).toBe(0.5);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY]).toBe(0.3);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_STOP_SEQUENCES]).toEqual(['END']);
  });

  it('captures Bedrock input and output messages when captureMessageContent is enabled', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('bedrock', BEDROCK_CHAT_RESPONSE);

    const model = createModel('bedrock');
    await model.invoke([
      new SystemMessage('You are a geography expert.'),
      new HumanMessage('What is the capital of France?'),
    ]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeDefined();
    expect(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeDefined();

    const inputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(inputMessages, 'gen-ai-input-messages');

    const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
    expect(outputMessages[0].role).toBe('assistant');
  });

  it('creates an Anthropic chat span with correct attributes', async () => {
    instrumentation.enable();
    nockProvider('anthropic', ANTHROPIC_CHAT_RESPONSE);

    const model = createModel('anthropic');
    const result = await model.invoke([new HumanMessage('What is the capital of France?')]);

    expect(result.content).toContain('Paris is the capital of France.');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.name).toContain(`chat ${ANTHROPIC_MODEL}`);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('anthropic');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(ANTHROPIC_MODEL);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(25);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_ID]).toBe('msg_01XFDUDYJgAACzvnptvVoYEL');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_TEMPERATURE]).toBe(0.5);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MAX_TOKENS]).toBe(256);
    expect(span.attributes[ATTR_GEN_AI_REQUEST_TOP_K]).toBe(40);
  });

  it('creates a chat span with tool_call finish reason for Anthropic tool use', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('anthropic', ANTHROPIC_TOOL_CALL_RESPONSE);

    const model = createModel('anthropic');
    await model.invoke([new HumanMessage('What is the weather in Tokyo?')]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['tool_call']);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(40);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(20);

    const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
    expect(outputMessages.length).toBe(1);
    const toolCallParts = outputMessages[0].parts.filter((p: any) => p.type === 'tool_call');
    expect(toolCallParts.length).toBe(1);
    expect(toolCallParts[0].name).toBe('get_weather');
  });

  it('captures Anthropic input and output messages when captureMessageContent is enabled', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('anthropic', ANTHROPIC_CHAT_RESPONSE);

    const model = createModel('anthropic');
    await model.invoke([
      new SystemMessage('You are a geography expert.'),
      new HumanMessage('What is the capital of France?'),
    ]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeDefined();
    expect(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeDefined();

    const inputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(inputMessages, 'gen-ai-input-messages');

    const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
    expect(outputMessages[0].role).toBe('assistant');
  });

  it('captures OpenAI input and output messages when captureMessageContent is enabled', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('openai', OPENAI_CHAT_RESPONSE);

    const model = createModel('openai');
    await model.invoke([
      new SystemMessage('You are a geography expert.'),
      new HumanMessage('What is the capital of France?'),
    ]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeDefined();
    expect(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeDefined();

    const inputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(inputMessages, 'gen-ai-input-messages');

    const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
    expect(outputMessages[0].role).toBe('assistant');
  });

  it('does not capture messages when captureMessageContent is disabled', async () => {
    instrumentation.enable();
    nockProvider('bedrock', BEDROCK_CHAT_RESPONSE);

    const model = createModel('bedrock');
    await model.invoke([new HumanMessage('What is the capital of France?')]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(chatSpans[0].attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
  });
});

describe('tool spans', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
  });

  it('creates a tool span with all attributes', async () => {
    contentCaptureInstrumentation.enable();

    const addTool = tool(async (input: { a: number; b: number }) => String(input.a + input.b), {
      name: 'add_numbers',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
    });

    const result = await addTool.invoke({ a: 1, b: 2 });
    expect(result).toBe('3');

    const spans = getTestSpans();
    const toolSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool');
    expect(toolSpans.length).toBe(1);

    const span = toolSpans[0];
    expect(span.name).toContain('execute_tool');
    expect(span.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('add_numbers');
    expect(span.attributes[ATTR_GEN_AI_TOOL_TYPE]).toBe('function');
    expect(span.attributes[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]).toBeDefined();
    expect(span.attributes[ATTR_GEN_AI_TOOL_CALL_RESULT]).toBe('3');
  });

  it('records error status on tool failure', async () => {
    contentCaptureInstrumentation.enable();

    const failTool = tool(
      async () => {
        throw new Error('Tool failed');
      },
      { name: 'fail_tool', description: 'Always fails', schema: z.object({}) }
    );

    try {
      await failTool.invoke({});
    } catch {
      /* expected */
    }

    const spans = getTestSpans();
    const toolSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool');
    expect(toolSpans.length).toBe(1);
    expect(toolSpans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(toolSpans[0].attributes[ATTR_ERROR_TYPE]).toBeDefined();
  });
});

describe('error handling', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
  });

  it('records error status on LLM failure', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['ok'] });
    const restore = stubGenerate(llm);

    const proto = Object.getPrototypeOf(llm);
    proto._generate = async function () {
      throw new Error('LLM failed');
    };

    try {
      await llm.invoke('test');
    } catch {
      /* expected */
    }

    restore();

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('chain error does not crash instrumentation', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['hello'] });
    const chain = RunnableLambda.from((x: string) => x)
      .pipe(llm)
      .pipe(
        RunnableLambda.from(() => {
          throw new Error('chain boom');
        })
      );

    try {
      await chain.invoke('test');
    } catch {
      /* expected */
    }

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
  });
});

describe('message content', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
  });

  it('validates input and output message structure', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['Hello!'] });
    await llm.invoke('Say hello');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    const span = chatSpans[0];

    const inputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(inputMessages, 'gen-ai-input-messages');
    expect(inputMessages[0].role).toBe('user');
    expect(inputMessages[0].parts[0].type).toBe('text');

    const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
    expect(outputMessages[0].role).toBe('assistant');
    expect(outputMessages[0].parts[0].type).toBe('text');
  });

  it('extracts system instructions separately', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['Hi!'] });
    await llm.invoke([new SystemMessage('You are a helpful assistant.'), new HumanMessage('Hello')]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    const span = chatSpans[0];

    expect(span.attributes[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeDefined();
    const instructions = JSON.parse(span.attributes[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS] as string);
    await validateOtelGenaiSchema(instructions, 'gen-ai-system-instructions');
    expect(instructions[0].type).toBe('text');
    expect(instructions[0].content).toContain('helpful assistant');
  });
});

describe('chain suppression', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
  });

  const chainFactories: Array<{ name: string; build: (llm: BaseChatModel) => unknown }> = [
    {
      name: 'RunnableLambda',
      build: llm => RunnableLambda.from((x: string) => x).pipe(llm),
    },
    {
      name: 'RunnableSequence',
      build: llm =>
        RunnableLambda.from((x: string) => x)
          .pipe(RunnableLambda.from((x: unknown) => x))
          .pipe(llm),
    },
  ];

  for (const { name, build } of chainFactories) {
    it(`suppresses internal chain spans for ${name}`, async () => {
      contentCaptureInstrumentation.enable();
      resetMemoryExporter();

      const llm = new FakeListChatModel({ responses: ['Hello!'] });
      const chain = build(llm) as { invoke: (input: string) => Promise<unknown> };
      await chain.invoke('hello');

      const spans = getTestSpans();
      expect(spans.length).toBeGreaterThan(0);
      const suppressed = spans.filter(
        (s: ReadableSpan) => s.name.includes('Runnable') || s.name.includes('Parser') || s.name.includes('Prompt')
      );
      expect(suppressed.length).toBe(0);
    });
  }
});

describe('disable/uninstrument', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  it('produces no spans when instrumentation is disabled', async () => {
    instrumentation.disable();

    const llm = new FakeListChatModel({ responses: ['test'] });
    await llm.invoke('test');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(0);
  });
});

describe('text completion', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
  });

  it('creates a text_completion span for FakeLLM', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeLLM({ response: 'hello' });
    await llm.invoke('test prompt');

    const spans = getTestSpans();
    const completionSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'text_completion'
    );
    expect(completionSpans.length).toBe(1);
    expect(completionSpans[0].name).toContain('text_completion');

    expect(completionSpans[0].attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeDefined();
    const inputMessages = JSON.parse(completionSpans[0].attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    expect(inputMessages[0].role).toBe('user');
    expect(inputMessages[0].parts[0].content).toContain('test prompt');
  });
});

describe('tool call responses', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
    nock.cleanAll();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
    nock.cleanAll();
  });

  it('creates a chat span with tool_call finish reason for Bedrock tool use', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('bedrock', BEDROCK_TOOL_CALL_RESPONSE);

    const model = createModel('bedrock');
    await model.invoke([new HumanMessage('What is the weather in Tokyo?')]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['tool_call']);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(40);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(20);

    const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
    await validateOtelGenaiSchema(outputMessages, 'gen-ai-output-messages');
    expect(outputMessages.length).toBe(1);
    const toolCallParts = outputMessages[0].parts.filter((p: any) => p.type === 'tool_call');
    expect(toolCallParts.length).toBe(1);
    expect(toolCallParts[0].name).toBe('get_weather');
  });

  it('creates a chat span with tool_call finish reason for OpenAI tool use', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('openai', OPENAI_TOOL_CALL_RESPONSE);

    const model = createModel('openai');
    await model.invoke([new HumanMessage('What is the weather in Tokyo?')]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['tool_call']);
  });
});

describe('provider error handling', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
    nock.cleanAll();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
    nock.cleanAll();
  });

  it('records error status on OpenAI server error', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('openai', OPENAI_ERROR_RESPONSE, 500);

    const model = createModel('openai', { maxRetries: 0 });
    try {
      await model.invoke([new HumanMessage('test')]);
    } catch {
      /* expected */
    }

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(chatSpans[0].attributes[ATTR_ERROR_TYPE]).toBeDefined();
  });

  it('records error status on Bedrock server error', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('bedrock', BEDROCK_ERROR_RESPONSE, 429);

    const model = createModel('bedrock');
    try {
      await model.invoke([new HumanMessage('test')]);
    } catch {
      /* expected */
    }

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(chatSpans[0].attributes[ATTR_ERROR_TYPE]).toBeDefined();
  });

  it('records error status on Anthropic server error', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('anthropic', ANTHROPIC_ERROR_RESPONSE, 529);

    const model = createModel('anthropic', { maxRetries: 0 });
    try {
      await model.invoke([new HumanMessage('test')]);
    } catch {
      /* expected */
    }

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(chatSpans[0].attributes[ATTR_ERROR_TYPE]).toBeDefined();
  });
});

describe('message formatting edge cases', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
  });

  it('handles AI messages with tool_calls in input', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['Done.'] });
    await llm.invoke([
      new HumanMessage('What is the weather?'),
      new AIMessage({
        content: 'Let me check.',
        tool_calls: [{ name: 'get_weather', args: { city: 'Paris' }, id: 'call_123', type: 'tool_call' }],
      }),
      new ToolMessage({ content: '72F and sunny', tool_call_id: 'call_123' }),
      new HumanMessage('Thanks!'),
    ]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const inputMessages = JSON.parse(chatSpans[0].attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    const roles = inputMessages.map((m: any) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');

    const assistantMsg = inputMessages.find((m: any) => m.role === 'assistant');
    const toolCallParts = assistantMsg.parts.filter((p: any) => p.type === 'tool_call');
    expect(toolCallParts.length).toBe(1);
    expect(toolCallParts[0].name).toBe('get_weather');

    const toolMsg = inputMessages.find((m: any) => m.role === 'tool');
    const responseParts = toolMsg.parts.filter((p: any) => p.type === 'tool_call_response');
    expect(responseParts.length).toBe(1);
    expect(responseParts[0].id).toBe('call_123');

    const textParts = toolMsg.parts.filter((p: any) => p.type === 'text');
    expect(textParts.length).toBe(0);
  });

  it('handles AI messages with array content blocks', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['ok'] });
    await llm.invoke([
      new HumanMessage({
        content: [
          { type: 'text', text: 'First part.' },
          { type: 'text', text: ' Second part.' },
        ],
      }),
    ]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);

    const inputMessages = JSON.parse(chatSpans[0].attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    expect(inputMessages[0].parts[0].content).toContain('First part.');
    expect(inputMessages[0].parts[0].content).toContain('Second part.');
  });

  it('suppresses chains with langgraph metadata', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['ok'] });
    const chain = RunnableLambda.from((x: string) => x).pipe(llm);
    await chain.invoke('test');

    const spans = getTestSpans();
    const chainSpans = spans.filter(
      (s: ReadableSpan) =>
        !s.attributes[ATTR_GEN_AI_OPERATION_NAME] ||
        (s.attributes[ATTR_GEN_AI_OPERATION_NAME] !== 'chat' &&
          s.attributes[ATTR_GEN_AI_OPERATION_NAME] !== 'text_completion' &&
          s.attributes[ATTR_GEN_AI_OPERATION_NAME] !== 'execute_tool')
    );
    expect(chainSpans.length).toBe(0);
  });
});

describe('streaming', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
  });

  it('creates a chat span when using stream()', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['Hello!', 'World!'], sleep: 0 });
    await llm.invoke('warm up');
    resetMemoryExporter();

    const stream = await llm.stream('test streaming');
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk.content === 'string' ? chunk.content : '');
    }
    expect(chunks.join('')).toContain('World');

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
  });
});

describe('provider detection (all providers)', function () {
  this.timeout(15000);

  const providerCases: Array<{
    name: string;
    createModel: () => BaseChatModel;
    expectedProvider: string;
  }> = [
    {
      name: 'ChatBedrockConverse',
      createModel: () =>
        new ChatBedrockConverse({
          model: 'test',
          region: 'us-east-1',
          credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
        }),
      expectedProvider: 'aws.bedrock',
    },
    {
      name: 'ChatOpenAI',
      createModel: () =>
        new ChatOpenAI({
          apiKey: FAKE_OPENAI_KEY,
          model: 'test',
        }),
      expectedProvider: 'openai',
    },
    {
      name: 'AzureChatOpenAI',
      createModel: () =>
        new AzureChatOpenAI({
          apiKey: FAKE_OPENAI_KEY,
          azureOpenAIApiDeploymentName: 'test',
          azureOpenAIApiInstanceName: 'fake',
          azureOpenAIApiVersion: '2024-01-01',
        }),
      expectedProvider: 'azure.ai.openai',
    },
    {
      name: 'ChatAnthropic',
      createModel: () =>
        new ChatAnthropic({
          anthropicApiKey: 'fake',
          modelName: 'claude-3',
        }),
      expectedProvider: 'anthropic',
    },
    {
      name: 'ChatGoogleGenerativeAI',
      createModel: () =>
        new ChatGoogleGenerativeAI({
          apiKey: 'fake',
          model: 'gemini-pro',
        }),
      expectedProvider: 'gcp.gen_ai',
    },
    {
      name: 'ChatMistralAI',
      createModel: () =>
        new ChatMistralAI({
          apiKey: 'fake',
          model: 'test',
        }),
      expectedProvider: 'mistral_ai',
    },
    {
      name: 'ChatGroq',
      createModel: () =>
        new ChatGroq({
          apiKey: 'fake',
          model: 'test',
        }),
      expectedProvider: 'groq',
    },
    {
      name: 'ChatCohere',
      createModel: () =>
        new ChatCohere({
          apiKey: 'fake',
          model: 'test',
        }),
      expectedProvider: 'cohere',
    },
    {
      name: 'ChatDeepSeek',
      createModel: () =>
        new ChatDeepSeek({
          apiKey: 'fake',
          model: 'test',
        }),
      expectedProvider: 'deepseek',
    },
    {
      name: 'ChatXAI',
      createModel: () =>
        new ChatXAI({
          apiKey: 'fake',
          model: 'test',
        }),
      expectedProvider: 'x_ai',
    },
  ];

  for (const { name, createModel, expectedProvider } of providerCases) {
    it(`detects provider for ${name} as "${expectedProvider}"`, async function () {
      contentCaptureInstrumentation.enable();
      resetMemoryExporter();

      const model = createModel();
      const restore = stubGenerate(model);

      try {
        await model.invoke('test');

        const spans = getTestSpans();
        const chatSpans = spans.filter(
          (s: ReadableSpan) =>
            s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat' ||
            s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'text_completion'
        );
        expect(chatSpans.length).toBeGreaterThanOrEqual(1);

        const span = chatSpans[0];
        expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(expectedProvider);
        expect(span.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe('chat');
        expect(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeDefined();
        expect(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeDefined();
        await validateOtelGenaiSchema(
          JSON.parse(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string),
          'gen-ai-input-messages'
        );
        await validateOtelGenaiSchema(
          JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string),
          'gen-ai-output-messages'
        );
        expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
        expect(span.attributes[ATTR_GEN_AI_RESPONSE_MODEL]).toBe('test');
      } finally {
        restore();
        contentCaptureInstrumentation.disable();
      }
    });
  }
});

describe('finish reason normalization', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
    nock.cleanAll();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
    nock.cleanAll();
  });

  it('normalizes "max_tokens" finish reason to "length"', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('openai', {
      ...OPENAI_CHAT_RESPONSE,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Truncated response.' },
          finish_reason: 'length',
        },
      ],
    });

    const model = createModel('openai');
    await model.invoke([new HumanMessage('Write a long essay')]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['length']);
  });

  it('normalizes "content_filter" finish reason', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('openai', {
      ...OPENAI_CHAT_RESPONSE,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'content_filter',
        },
      ],
    });

    const model = createModel('openai');
    await model.invoke([new HumanMessage('test')]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['content_filter']);
  });

  it('passes through unknown finish reasons unchanged', async () => {
    contentCaptureInstrumentation.enable();
    nockProvider('openai', {
      ...OPENAI_CHAT_RESPONSE,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'custom_reason',
        },
      ],
    });

    const model = createModel('openai');
    await model.invoke([new HumanMessage('test')]);

    const spans = getTestSpans();
    const chatSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['custom_reason']);
  });
});

describe('invoke_agent spans', function () {
  this.timeout(15000);

  const agentCases: Array<{
    name: string;
    createModel: () => BaseChatModel;
    expectedProvider: string;
    expectedModel: string;
    expectedTemperature?: number;
  }> = [
    {
      name: 'ChatBedrockConverse',
      createModel: () =>
        new ChatBedrockConverse({
          model: BEDROCK_MODEL_ID,
          region: REGION,
          credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
          temperature: 0.5,
        }),
      expectedProvider: 'aws.bedrock',
      expectedModel: BEDROCK_MODEL_ID,
      expectedTemperature: 0.5,
    },
    {
      name: 'ChatOpenAI',
      createModel: () =>
        new ChatOpenAI({
          apiKey: FAKE_OPENAI_KEY,
          model: OPENAI_MODEL,
          temperature: 0.7,
        }),
      expectedProvider: 'openai',
      expectedModel: OPENAI_MODEL,
      expectedTemperature: 0.7,
    },
    {
      name: 'ChatAnthropic',
      createModel: () =>
        new ChatAnthropic({
          anthropicApiKey: 'fake',
          modelName: 'claude-3',
          temperature: 0.5,
        }),
      expectedProvider: 'anthropic',
      expectedModel: 'claude-3',
      expectedTemperature: 0.5,
    },
  ];

  for (const { name, createModel, expectedProvider, expectedModel, expectedTemperature } of agentCases) {
    it(`creates an invoke_agent span with ${name} and propagates LLM attributes`, async function () {
      contentCaptureInstrumentation.enable();
      resetMemoryExporter();

      const weatherTool = tool(async (input: { location: string }) => `Sunny in ${input.location}`, {
        name: 'get_weather',
        description: 'Get weather for a location',
        schema: z.object({ location: z.string() }),
      });

      const model = createModel();
      const restore = stubGenerate(model);

      try {
        const agent = createReactAgent({ llm: model, tools: [weatherTool] });
        await agent.invoke({ messages: [new HumanMessage('What is the weather?')] });
      } catch {
        /* agent may error after first LLM call — spans are still emitted */
      }

      restore();

      const spans = getTestSpans();
      const agentSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
      expect(agentSpans.length).toBeGreaterThanOrEqual(1);

      const agentSpan = agentSpans[0];
      expect(agentSpan.name).toContain('invoke_agent');
      expect(agentSpan.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe('invoke_agent');
      expect(agentSpan.attributes[ATTR_GEN_AI_AGENT_NAME]).toBe('LangGraph');
      expect(agentSpan.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(expectedModel);
      expect(agentSpan.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe(expectedProvider);
      if (expectedTemperature !== undefined) {
        expect(agentSpan.attributes[ATTR_GEN_AI_REQUEST_TEMPERATURE]).toBe(expectedTemperature);
      }
    });
  }

  it('creates an invoke_agent span for named createReactAgent', async function () {
    contentCaptureInstrumentation.enable();
    resetMemoryExporter();

    const weatherTool = tool(async (input: { location: string }) => `Sunny in ${input.location}`, {
      name: 'get_weather',
      description: 'Get weather for a location',
      schema: z.object({ location: z.string() }),
    });

    const model = new ChatOpenAI({ apiKey: FAKE_OPENAI_KEY, model: OPENAI_MODEL });
    const restore = stubGenerate(model);

    try {
      const agent = createReactAgent({ llm: model, tools: [weatherTool], name: 'research-analyst' });
      await agent.invoke({ messages: [new HumanMessage('What is the weather?')] });
    } catch {
      /* agent may error after first LLM call — spans are still emitted */
    }

    restore();

    const spans = getTestSpans();
    const agentSpans = spans.filter((s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
    expect(agentSpans.length).toBeGreaterThanOrEqual(1);

    const agentSpan = agentSpans[0];
    expect(agentSpan.name).toBe('invoke_agent research-analyst');
    expect(agentSpan.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe('invoke_agent');
    expect(agentSpan.attributes[ATTR_GEN_AI_AGENT_NAME]).toBe('research-analyst');
  });
});

describe('setConfig resets handler', function () {
  it('recreates handler when captureMessageContent changes', function () {
    const instr = new LangChainInstrumentation({ captureMessageContent: false });
    instr.enable();

    // Access the internal handler by triggering lazy creation
    expect(instr._handler).toBeUndefined();

    instr.setConfig({ captureMessageContent: true });
    expect(instr._handler).toBeUndefined();

    instr.disable();
  });
});

describe('_handleError cleans up skipped chain entries', function () {
  it('removes map entry for skipped chains on error', function () {
    const tracer = trace.getTracer('test');
    const handler = new OpenTelemetryCallbackHandler(tracer, false);

    // Simulate a skipped chain entry (no span, just context)
    handler.runIdToSpanMap.set('skipped-run-id', {
      context: {} as OtelContext,
      agentSpan: undefined,
    });

    expect(handler.runIdToSpanMap.has('skipped-run-id')).toBe(true);

    // Call handleChainError which calls _handleError
    handler.handleChainError(new Error('test error'), 'skipped-run-id');

    expect(handler.runIdToSpanMap.has('skipped-run-id')).toBe(false);
  });
});
