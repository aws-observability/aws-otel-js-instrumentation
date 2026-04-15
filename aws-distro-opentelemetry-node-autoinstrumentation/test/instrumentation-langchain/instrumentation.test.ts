// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { instrumentation, contentCaptureInstrumentation } from './load-instrumentation';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_ERROR_TYPE,
} from '@opentelemetry/semantic-conventions/incubating';
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
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { FakeListChatModel, FakeLLM } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { RunnableLambda } from '@langchain/core/runnables';
import { z } from 'zod';
import type { ChatResult } from '@langchain/core/outputs';
import {
  BEDROCK_CHAT_RESPONSE,
  OPENAI_CHAT_RESPONSE,
} from './mock-responses';

const REGION = 'us-east-1';
const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const OPENAI_MODEL = 'gpt-4o-mini';
const FAKE_OPENAI_KEY = 'sk-test1234567890abcdef1234567890abcdef1234567890abcdef';

function createBedrockModel(): ChatBedrockConverse {
  const client = new BedrockRuntimeClient({
    region: REGION,
    credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
    requestHandler: new NodeHttpHandler(),
  });
  return new ChatBedrockConverse({
    model: BEDROCK_MODEL_ID,
    region: REGION,
    client,
  });
}

function createOpenAIModel(opts: Record<string, unknown> = {}): ChatOpenAI {
  return new ChatOpenAI({
    model: OPENAI_MODEL,
    apiKey: FAKE_OPENAI_KEY,
    temperature: 0.7,
    maxTokens: 256,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    configuration: { fetch: require('node-fetch') },
    ...opts,
  });
}

function nockBedrockConverse(response: Record<string, unknown>): nock.Scope {
  return nock(`https://bedrock-runtime.${REGION}.amazonaws.com`)
    .post(/.*/)
    .reply(200, JSON.stringify(response), {
      'content-type': 'application/json',
      'x-amzn-requestid': 'req-bedrock-1234',
    });
}

function nockOpenAIChat(response: Record<string, unknown>): nock.Scope {
  return nock('https://api.openai.com')
    .post('/v1/chat/completions')
    .reply(200, response, { 'content-type': 'application/json' });
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
  return () => { proto._generate = original; };
}

describe('LangChain instrumentation – ChatBedrockConverse', function () {
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

  it('creates a chat span with correct attributes', async () => {
    instrumentation.enable();
    nockBedrockConverse(BEDROCK_CHAT_RESPONSE);

    const model = createBedrockModel();
    const result = await model.invoke([new HumanMessage('What is the capital of France?')]);

    expect(result.content).toBe('Paris is the capital of France.');

    const spans = getTestSpans();
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('aws.bedrock');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(BEDROCK_MODEL_ID);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(25);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_ID]).toBe('req-bedrock-1234');
  });

  it('captures input and output messages when captureMessageContent is enabled', async () => {
    contentCaptureInstrumentation.enable();
    nockBedrockConverse(BEDROCK_CHAT_RESPONSE);

    const model = createBedrockModel();
    await model.invoke([
      new SystemMessage('You are a geography expert.'),
      new HumanMessage('What is the capital of France?'),
    ]);

    const spans = getTestSpans();
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeDefined();
    expect(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeDefined();

    const inputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    expect(inputMessages.length).toBeGreaterThanOrEqual(1);

    const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
    expect(outputMessages.length).toBe(1);
    expect(outputMessages[0].role).toBe('assistant');
  });

  it('does not capture messages when captureMessageContent is disabled', async () => {
    instrumentation.enable();
    nockBedrockConverse(BEDROCK_CHAT_RESPONSE);

    const model = createBedrockModel();
    await model.invoke([new HumanMessage('What is the capital of France?')]);

    const spans = getTestSpans();
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(chatSpans[0].attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
  });
});

describe('LangChain instrumentation – ChatOpenAI', function () {
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

  it('creates a chat span with correct attributes', async () => {
    instrumentation.enable();
    nockOpenAIChat(OPENAI_CHAT_RESPONSE);

    const model = createOpenAIModel();
    const result = await model.invoke([new HumanMessage('What is the capital of France?')]);

    expect(result.content).toBe('Paris is the capital of France.');

    const spans = getTestSpans();
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('openai');
    expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(OPENAI_MODEL);
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(18);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(8);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
    expect(span.attributes[ATTR_GEN_AI_RESPONSE_ID]).toBe('chatcmpl-abc123');
  });

  it('captures input and output messages when captureMessageContent is enabled', async () => {
    contentCaptureInstrumentation.enable();
    nockOpenAIChat(OPENAI_CHAT_RESPONSE);

    const model = createOpenAIModel();
    await model.invoke([
      new SystemMessage('You are a geography expert.'),
      new HumanMessage('What is the capital of France?'),
    ]);

    const spans = getTestSpans();
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(1);

    const span = chatSpans[0];
    expect(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeDefined();
    expect(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeDefined();
  });
});

describe('LangChain instrumentation – tool spans', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  afterEach(() => {
    contentCaptureInstrumentation.disable();
  });

  it('creates a tool span with all attributes', async () => {
    contentCaptureInstrumentation.enable();

    const addTool = tool(
      async (input: { a: number; b: number }) => String(input.a + input.b),
      { name: 'add_numbers', description: 'Add two numbers', schema: z.object({ a: z.number(), b: z.number() }) }
    );

    const result = await addTool.invoke({ a: 1, b: 2 });
    expect(result).toBe('3');

    const spans = getTestSpans();
    const toolSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool'
    );
    expect(toolSpans.length).toBe(1);

    const span = toolSpans[0];
    expect(span.name).toContain('execute_tool');
    expect(span.attributes[ATTR_GEN_AI_TOOL_TYPE]).toBe('function');
    expect(span.attributes[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]).toBeDefined();
    expect(span.attributes[ATTR_GEN_AI_TOOL_CALL_RESULT]).toBe('3');
  });

  it('records error status on tool failure', async () => {
    contentCaptureInstrumentation.enable();

    const failTool = tool(
      async () => { throw new Error('Tool failed'); },
      { name: 'fail_tool', description: 'Always fails', schema: z.object({}) }
    );

    try {
      await failTool.invoke({});
    } catch { /* expected */ }

    const spans = getTestSpans();
    const toolSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool'
    );
    expect(toolSpans.length).toBe(1);
    expect(toolSpans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(toolSpans[0].attributes[ATTR_ERROR_TYPE]).toBeDefined();
  });
});

describe('LangChain instrumentation – error handling', function () {
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
    } catch { /* expected */ }

    restore();

    const spans = getTestSpans();
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(1);
    expect(chatSpans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('chain error does not crash instrumentation', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['hello'] });
    const chain = RunnableLambda.from((x: string) => x)
      .pipe(llm)
      .pipe(RunnableLambda.from(() => { throw new Error('chain boom'); }));

    try {
      await chain.invoke('test');
    } catch { /* expected */ }

    const spans = getTestSpans();
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(1);
  });
});

describe('LangChain instrumentation – message content', function () {
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
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(1);
    const span = chatSpans[0];

    const inputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_INPUT_MESSAGES] as string);
    expect(Array.isArray(inputMessages)).toBe(true);
    expect(inputMessages.length).toBeGreaterThan(0);
    expect(inputMessages[0].role).toBe('user');
    expect(inputMessages[0].parts[0].type).toBe('text');

    const outputMessages = JSON.parse(span.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string);
    expect(Array.isArray(outputMessages)).toBe(true);
    expect(outputMessages.length).toBeGreaterThan(0);
    expect(outputMessages[0].role).toBe('assistant');
    expect(outputMessages[0].parts[0].type).toBe('text');
  });

  it('extracts system instructions separately', async () => {
    contentCaptureInstrumentation.enable();

    const llm = new FakeListChatModel({ responses: ['Hi!'] });
    await llm.invoke([
      new SystemMessage('You are a helpful assistant.'),
      new HumanMessage('Hello'),
    ]);

    const spans = getTestSpans();
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(1);
    const span = chatSpans[0];

    expect(span.attributes[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeDefined();
    const instructions = JSON.parse(span.attributes[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS] as string);
    expect(instructions[0].type).toBe('text');
    expect(instructions[0].content).toContain('helpful assistant');
  });
});

describe('LangChain instrumentation – chain suppression', function () {
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
      build: (llm) => RunnableLambda.from((x: string) => x).pipe(llm),
    },
    {
      name: 'RunnableSequence',
      build: (llm) => RunnableLambda.from((x: string) => x)
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
        (s: ReadableSpan) =>
          s.name.includes('Runnable') || s.name.includes('Parser') || s.name.includes('Prompt')
      );
      expect(suppressed.length).toBe(0);
    });
  }
});

describe('LangChain instrumentation – disable/uninstrument', function () {
  this.timeout(10000);

  beforeEach(() => {
    resetMemoryExporter();
  });

  it('produces no spans when instrumentation is disabled', async () => {
    instrumentation.disable();

    const llm = new FakeListChatModel({ responses: ['test'] });
    await llm.invoke('test');

    const spans = getTestSpans();
    const chatSpans = spans.filter(
      (s: ReadableSpan) => s.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(chatSpans.length).toBe(0);
  });
});

describe('LangChain instrumentation – text completion', function () {
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

describe('LangChain instrumentation – provider detection (all providers)', function () {
  this.timeout(15000);

  const providerCases: Array<{
    name: string;
    createModel: () => BaseChatModel;
    expectedProvider: string;
  }> = [
    {
      name: 'ChatBedrockConverse',
      createModel: () => new ChatBedrockConverse({
        model: 'test',
        region: 'us-east-1',
        credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
      }),
      expectedProvider: 'aws.bedrock',
    },
    {
      name: 'ChatOpenAI',
      createModel: () => new ChatOpenAI({
        apiKey: FAKE_OPENAI_KEY,
        model: 'test',
      }),
      expectedProvider: 'openai',
    },
    {
      name: 'AzureChatOpenAI',
      createModel: () => new AzureChatOpenAI({
        apiKey: FAKE_OPENAI_KEY,
        azureOpenAIApiDeploymentName: 'test',
        azureOpenAIApiInstanceName: 'fake',
        azureOpenAIApiVersion: '2024-01-01',
      }),
      expectedProvider: 'azure.ai.openai',
    },
    {
      name: 'ChatAnthropic',
      createModel: () => new ChatAnthropic({
        anthropicApiKey: 'fake',
        modelName: 'claude-3',
      }),
      expectedProvider: 'anthropic',
    },
    {
      name: 'ChatGoogleGenerativeAI',
      createModel: () => new ChatGoogleGenerativeAI({
        apiKey: 'fake',
        model: 'gemini-pro',
      }),
      expectedProvider: 'gcp.gen_ai',
    },
    {
      name: 'ChatMistralAI',
      createModel: () => new ChatMistralAI({
        apiKey: 'fake',
        model: 'test',
      }),
      expectedProvider: 'mistral_ai',
    },
    {
      name: 'ChatGroq',
      createModel: () => new ChatGroq({
        apiKey: 'fake',
        model: 'test',
      }),
      expectedProvider: 'groq',
    },
    {
      name: 'ChatCohere',
      createModel: () => new ChatCohere({
        apiKey: 'fake',
        model: 'test',
      }),
      expectedProvider: 'cohere',
    },
    {
      name: 'ChatDeepSeek',
      createModel: () => new ChatDeepSeek({
        apiKey: 'fake',
        model: 'test',
      }),
      expectedProvider: 'deepseek',
    },
    {
      name: 'ChatXAI',
      createModel: () => new ChatXAI({
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
        expect(span.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
      } finally {
        restore();
        contentCaptureInstrumentation.disable();
      }
    });
  }
});
