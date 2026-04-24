// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export enum ProviderName {
  OPENAI = 'OpenAI',
  ANTHROPIC = 'Anthropic',
  BEDROCK = 'Amazon Bedrock',
  GOOGLE = 'Google',
  GROQ = 'Groq',
  MISTRAL = 'Mistral',
  COHERE = 'Cohere',
  XAI = 'xAI',
}

export const OPENAI_MODEL = 'gpt-4o-mini';
export const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
export const BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
export const GOOGLE_MODEL = 'gemini-1.5-flash';
export const GROQ_MODEL = 'llama-3.1-8b-instant';
export const MISTRAL_MODEL = 'mistral-large-latest';
export const COHERE_MODEL = 'command-r-plus';
export const XAI_MODEL = 'grok-2';

export const FAKE_OPENAI_KEY = 'sk-test1234567890abcdef1234567890abcdef1234567890abcdef';
export const FAKE_ANTHROPIC_KEY = 'sk-ant-test1234567890abcdef1234567890abcdef';
export const FAKE_GOOGLE_KEY = 'fake-google-key';
export const FAKE_GROQ_KEY = 'fake-groq-key';
export const FAKE_MISTRAL_KEY = 'fake-mistral-key';
export const FAKE_COHERE_KEY = 'fake-cohere-key';
export const FAKE_XAI_KEY = 'fake-xai-key';
export const FAKE_AWS_ACCESS_KEY_ID = 'testing';
export const FAKE_AWS_SECRET_ACCESS_KEY = 'testing';
export const AWS_REGION = 'us-east-1';

export interface ProviderTestCase {
  name: ProviderName;
  expectedProvider: string;
  expectedModel: string;
  chatResponse: Record<string, unknown>;
  toolCallResponse: Record<string, unknown>;
  errorResponse: Record<string, unknown>;
  errorStatusCode: number;
  expectedInputTokens: number;
  expectedOutputTokens: number;
  expectedResponseId?: string;
  useStub?: boolean;
  useChat?: boolean;
}

// https://platform.openai.com/docs/api-reference/chat/object
const OPENAI_CHAT_RESPONSE = {
  id: 'chatcmpl-abc123',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o-mini-2024-07-18',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Paris is the capital of France.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 },
  system_fingerprint: 'fp_abc123',
};

const OPENAI_TOOL_CALL_RESPONSE = {
  id: 'chatcmpl-tool456',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o-mini-2024-07-18',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_openai_001',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 52, completion_tokens: 18, total_tokens: 70 },
  system_fingerprint: 'fp_tool456',
};

const OPENAI_ERROR_RESPONSE = {
  error: {
    message: 'Internal server error',
    type: 'server_error',
    code: 'internal_error',
  },
};

// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
const BEDROCK_CHAT_RESPONSE = {
  output: { message: { role: 'assistant', content: [{ text: 'Paris is the capital of France.' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 18, outputTokens: 8, totalTokens: 26 },
  metrics: { latencyMs: 423 },
};

const BEDROCK_TOOL_CALL_RESPONSE = {
  output: {
    message: {
      role: 'assistant',
      content: [
        {
          toolUse: {
            toolUseId: 'call_bedrock_001',
            name: 'get_weather',
            input: { location: 'Tokyo' },
          },
        },
      ],
    },
  },
  stopReason: 'tool_use',
  usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
  metrics: { latencyMs: 312 },
};

const BEDROCK_ERROR_RESPONSE = {
  __type: 'ThrottlingException',
  message: 'Rate exceeded',
};

// https://docs.anthropic.com/en/api/messages
const ANTHROPIC_CHAT_RESPONSE = {
  id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-20250514',
  content: [{ type: 'text', text: 'Paris is the capital of France.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 18,
    output_tokens: 8,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

const ANTHROPIC_TOOL_CALL_RESPONSE = {
  id: 'msg_01YXK3MEvKm9bjR8yGbQWt5T',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-20250514',
  content: [
    { type: 'text', text: "I'll check the weather for you." },
    {
      type: 'tool_use',
      id: 'toolu_01D7FLrfh4GYq7yT1ULFeyMV',
      name: 'get_weather',
      input: { location: 'Tokyo' },
    },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 40,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

const ANTHROPIC_ERROR_RESPONSE = {
  type: 'error',
  error: {
    type: 'overloaded_error',
    message: 'Overloaded',
  },
};

// https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse
const GOOGLE_CHAT_RESPONSE = {
  candidates: [
    {
      content: { parts: [{ text: 'Paris is the capital of France.' }], role: 'model' },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 8, totalTokenCount: 26 },
};

const GOOGLE_TOOL_CALL_RESPONSE = {
  candidates: [
    {
      content: {
        parts: [{ functionCall: { name: 'get_weather', args: { location: 'Tokyo' } } }],
        role: 'model',
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20, totalTokenCount: 60 },
};

const GOOGLE_ERROR_RESPONSE = {
  error: {
    code: 500,
    message: 'Internal error encountered.',
    status: 'INTERNAL',
  },
};

// https://docs.cohere.com/reference/chat
const COHERE_CHAT_RESPONSE = {
  id: 'gen-test',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Paris is the capital of France.' }] },
  finish_reason: 'COMPLETE',
  usage: { billed_units: { input_tokens: 18, output_tokens: 8 }, tokens: { input_tokens: 18, output_tokens: 8 } },
};

const COHERE_TOOL_CALL_RESPONSE = {
  id: 'gen-tool-test',
  message: {
    role: 'assistant',
    tool_calls: [
      { id: 'call_cohere_001', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' } },
    ],
    content: [],
  },
  finish_reason: 'TOOL_CALL',
  usage: { billed_units: { input_tokens: 40, output_tokens: 20 }, tokens: { input_tokens: 40, output_tokens: 20 } },
};

const COHERE_ERROR_RESPONSE = {
  message: 'too many requests',
};

const providerTestCases: ProviderTestCase[] = [
  {
    name: ProviderName.OPENAI,
    expectedModel: OPENAI_MODEL,
    expectedProvider: 'openai',
    chatResponse: OPENAI_CHAT_RESPONSE,
    toolCallResponse: OPENAI_TOOL_CALL_RESPONSE,
    errorResponse: OPENAI_ERROR_RESPONSE,
    errorStatusCode: 500,
    expectedResponseId: 'chatcmpl-abc123',
    useChat: true,
    expectedInputTokens: 18,
    expectedOutputTokens: 8,
  },
  {
    name: ProviderName.ANTHROPIC,
    expectedModel: ANTHROPIC_MODEL,
    expectedProvider: 'anthropic',
    chatResponse: ANTHROPIC_CHAT_RESPONSE,
    toolCallResponse: ANTHROPIC_TOOL_CALL_RESPONSE,
    errorResponse: ANTHROPIC_ERROR_RESPONSE,
    errorStatusCode: 529,
    expectedResponseId: 'msg_01XFDUDYJgAACzvnptvVoYEL',
    expectedInputTokens: 18,
    expectedOutputTokens: 8,
  },
  {
    name: ProviderName.BEDROCK,
    expectedModel: BEDROCK_MODEL,
    expectedProvider: 'aws.bedrock',
    chatResponse: BEDROCK_CHAT_RESPONSE,
    toolCallResponse: BEDROCK_TOOL_CALL_RESPONSE,
    errorResponse: BEDROCK_ERROR_RESPONSE,
    errorStatusCode: 429,
    expectedResponseId: 'req-bedrock-1234',
    expectedInputTokens: 18,
    expectedOutputTokens: 8,
  },
  {
    name: ProviderName.GOOGLE,
    expectedModel: GOOGLE_MODEL,
    expectedProvider: 'gcp.gen_ai',
    chatResponse: GOOGLE_CHAT_RESPONSE,
    toolCallResponse: GOOGLE_TOOL_CALL_RESPONSE,
    errorResponse: GOOGLE_ERROR_RESPONSE,
    errorStatusCode: 500,
    useStub: true,
    expectedInputTokens: 18,
    expectedOutputTokens: 8,
  },
  {
    name: ProviderName.GROQ,
    expectedModel: GROQ_MODEL,
    expectedProvider: 'groq',
    chatResponse: OPENAI_CHAT_RESPONSE,
    toolCallResponse: OPENAI_TOOL_CALL_RESPONSE,
    errorResponse: OPENAI_ERROR_RESPONSE,
    errorStatusCode: 500,
    useStub: true,
    useChat: true,
    expectedInputTokens: 18,
    expectedOutputTokens: 8,
  },
  {
    name: ProviderName.MISTRAL,
    expectedModel: MISTRAL_MODEL,
    expectedProvider: 'mistral_ai',
    chatResponse: OPENAI_CHAT_RESPONSE,
    toolCallResponse: OPENAI_TOOL_CALL_RESPONSE,
    errorResponse: OPENAI_ERROR_RESPONSE,
    errorStatusCode: 500,
    useStub: true,
    useChat: true,
    expectedInputTokens: 18,
    expectedOutputTokens: 8,
  },
  {
    name: ProviderName.COHERE,
    expectedModel: COHERE_MODEL,
    expectedProvider: 'cohere',
    chatResponse: COHERE_CHAT_RESPONSE,
    toolCallResponse: COHERE_TOOL_CALL_RESPONSE,
    errorResponse: COHERE_ERROR_RESPONSE,
    errorStatusCode: 429,
    useStub: true,
    expectedInputTokens: 18,
    expectedOutputTokens: 8,
  },
  {
    name: ProviderName.XAI,
    expectedModel: XAI_MODEL,
    expectedProvider: 'x_ai',
    chatResponse: OPENAI_CHAT_RESPONSE,
    toolCallResponse: OPENAI_TOOL_CALL_RESPONSE,
    errorResponse: OPENAI_ERROR_RESPONSE,
    errorStatusCode: 500,
    useStub: true,
    useChat: true,
    expectedInputTokens: 18,
    expectedOutputTokens: 8,
  },
];

export function getProviderCases(): ProviderTestCase[] {
  return providerTestCases;
}

// https://platform.openai.com/docs/api-reference/responses/object
export const OPENAI_RESPONSES_API_CHAT_RESPONSE = {
  id: 'resp_abc123',
  object: 'response',
  created_at: 1700000000,
  model: 'gpt-4o-mini-2024-07-18',
  output: [
    {
      type: 'message',
      id: 'msg_001',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Paris is the capital of France.' }],
    },
  ],
  usage: { input_tokens: 18, output_tokens: 8, total_tokens: 26 },
  temperature: 1.0,
  top_p: 1.0,
  tools: [],
};

export const OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE = {
  id: 'resp_tool456',
  object: 'response',
  created_at: 1700000000,
  model: 'gpt-4o-mini-2024-07-18',
  output: [
    {
      type: 'function_call',
      id: 'fc_001',
      call_id: 'call_001',
      name: 'get_weather',
      arguments: '{"city":"Tokyo"}',
      status: 'completed',
    },
  ],
  usage: { input_tokens: 15, output_tokens: 10, total_tokens: 25 },
  temperature: 1.0,
  top_p: 1.0,
  tools: [],
};

export const OPENAI_RESPONSES_API_ERROR_RESPONSE = {
  error: {
    message: 'Internal server error',
    type: 'server_error',
    code: 'internal_error',
  },
};


export function mockFetchJson(response: unknown, statusCode: number = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response), {
      status: statusCode,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

export function chatResponseWithFinishReason(
  pc: ProviderTestCase,
  finishReason: string,
  content: string = 'ok'
): Record<string, unknown> {
  switch (pc.name) {
    case ProviderName.OPENAI:
    case ProviderName.GROQ:
    case ProviderName.MISTRAL:
    case ProviderName.XAI:
      return {
        ...pc.chatResponse,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      };
    case ProviderName.ANTHROPIC:
      return { ...pc.chatResponse, stop_reason: finishReason };
    case ProviderName.BEDROCK:
      return { ...pc.chatResponse, stopReason: finishReason };
    case ProviderName.GOOGLE:
      return {
        ...pc.chatResponse,
        candidates: [{ content: { parts: [{ text: content }], role: 'model' }, finishReason }],
      };
    case ProviderName.COHERE:
      return { ...pc.chatResponse, finish_reason: finishReason };
  }
}
