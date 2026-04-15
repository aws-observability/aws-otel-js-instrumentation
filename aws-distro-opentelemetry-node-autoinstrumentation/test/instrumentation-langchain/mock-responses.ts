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
