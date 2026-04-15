// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { instrumentation, contentCaptureInstrumentation } from './load-instrumentation';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { SpanKind } from '@opentelemetry/api';
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
import type { ChatResult } from '@langchain/core/outputs';

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

const BEDROCK_CHAT_RESPONSE = {
  output: { message: { role: 'assistant', content: [{ text: 'Paris is the capital of France.' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
  metrics: { latencyMs: 423 },
};

const OPENAI_CHAT_RESPONSE = {
  id: 'chatcmpl-abc123',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o-mini-2024-07-18',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'Paris is the capital of France.' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 },
  system_fingerprint: 'fp_abc123',
};

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

  describe('chat completion', () => {
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

  describe('chat completion', () => {
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
