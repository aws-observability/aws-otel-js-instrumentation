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

export const GOOGLE_GEMINI_CHAT_RESPONSE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'Paris is the capital of France.' }],
      },
      finishReason: 'STOP',
      safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' }],
    },
  ],
  usageMetadata: {
    promptTokenCount: 25,
    candidatesTokenCount: 10,
    totalTokenCount: 35,
  },
  modelVersion: 'gemini-2.0-flash',
};

export const GOOGLE_GEMINI_TOOL_CALL_RESPONSE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'get_weather',
              args: { location: 'Tokyo' },
            },
          },
        ],
      },
      finishReason: 'STOP',
      safetyRatings: [],
    },
  ],
  usageMetadata: {
    promptTokenCount: 40,
    candidatesTokenCount: 20,
    totalTokenCount: 60,
  },
};

export const MISTRAL_CHAT_RESPONSE = {
  id: 'cmpl-e5cc70bb28c444948073e77776eb30ef',
  object: 'chat.completion',
  created: 1702256327,
  model: 'mistral-small-latest',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Paris is the capital of France.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 },
};

export const MISTRAL_TOOL_CALL_RESPONSE = {
  id: 'cmpl-abc123def456',
  object: 'chat.completion',
  created: 1702256400,
  model: 'mistral-small-latest',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_mistral_001',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
};

export const GROQ_CHAT_RESPONSE = {
  id: 'chatcmpl-f51b2cd2-bef7-417e-964e-a08f0b513c22',
  object: 'chat.completion',
  created: 1730241104,
  model: 'llama-3.3-70b-versatile',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Paris is the capital of France.' },
      logprobs: null,
      finish_reason: 'stop',
    },
  ],
  usage: {
    queue_time: 0.037493756,
    prompt_tokens: 25,
    prompt_time: 0.000680594,
    completion_tokens: 10,
    completion_time: 0.008333333,
    total_tokens: 35,
    total_time: 0.009013927,
  },
  system_fingerprint: 'fp_179b0f92c9',
  x_groq: { id: 'req_01jbd6g2qdfw2adyrt2az8hz4w' },
};

export const GROQ_TOOL_CALL_RESPONSE = {
  id: 'chatcmpl-groq-tool-001',
  object: 'chat.completion',
  created: 1730241200,
  model: 'llama-3.3-70b-versatile',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_groq_001',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' },
          },
        ],
      },
      logprobs: null,
      finish_reason: 'tool_calls',
    },
  ],
  usage: {
    queue_time: 0.02,
    prompt_tokens: 40,
    prompt_time: 0.001,
    completion_tokens: 20,
    completion_time: 0.05,
    total_tokens: 60,
    total_time: 0.051,
  },
  system_fingerprint: 'fp_179b0f92c9',
  x_groq: { id: 'req_01jbd6g2qdfw2adyrt2az8hz4w' },
};

export const COHERE_CHAT_RESPONSE = {
  id: 'cohere-resp-abc123',
  finish_reason: 'COMPLETE',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Paris is the capital of France.' }],
  },
  usage: {
    billed_units: { input_tokens: 25, output_tokens: 10, search_units: 0, classifications: 0 },
    tokens: { input_tokens: 25, output_tokens: 10 },
  },
};

export const COHERE_TOOL_CALL_RESPONSE = {
  id: 'cohere-resp-tool456',
  finish_reason: 'TOOL_CALL',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: "I'll check the weather for you." }],
    tool_calls: [
      {
        id: 'call_cohere_001',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' },
      },
    ],
    tool_plan: 'I will look up the current weather conditions for the requested location.',
  },
  usage: {
    billed_units: { input_tokens: 40, output_tokens: 20 },
    tokens: { input_tokens: 40, output_tokens: 20 },
  },
};
