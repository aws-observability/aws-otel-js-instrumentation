// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const BEDROCK_CHAT_RESPONSE = {
  output: { message: { role: 'assistant', content: [{ text: 'Paris is the capital of France.' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
  metrics: { latencyMs: 423 },
};

export const BEDROCK_TOOL_CALL_RESPONSE = {
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

export const OPENAI_CHAT_RESPONSE = {
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

export const OPENAI_TOOL_CALL_RESPONSE = {
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

export const OPENAI_ERROR_RESPONSE = {
  error: {
    message: 'Internal server error',
    type: 'server_error',
    code: 'internal_error',
  },
};

export const BEDROCK_ERROR_RESPONSE = {
  __type: 'ThrottlingException',
  message: 'Rate exceeded',
};

export const ANTHROPIC_ERROR_RESPONSE = {
  type: 'error',
  error: {
    type: 'overloaded_error',
    message: 'Overloaded',
  },
};

export const ANTHROPIC_CHAT_RESPONSE = {
  id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-20250514',
  content: [{ type: 'text', text: 'Paris is the capital of France.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 25,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

export const ANTHROPIC_TOOL_CALL_RESPONSE = {
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

export const GOOGLE_CHAT_RESPONSE = {
  candidates: [
    {
      content: { parts: [{ text: 'Paris is the capital of France.' }], role: 'model' },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 8, totalTokenCount: 26 },
};

export function mockFetchJson(response: unknown, statusCode: number = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response), {
      status: statusCode,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}
