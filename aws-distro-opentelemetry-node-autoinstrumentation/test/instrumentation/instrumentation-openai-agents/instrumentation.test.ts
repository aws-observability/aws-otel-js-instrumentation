// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { instrumentation } from './load-instrumentation';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
} from '../../../src/instrumentation/common/semconv';
import {
  FAKE_OPENAI_KEY,
  OPENAI_MODEL,
  OPENAI_RESPONSES_API_CHAT_RESPONSE,
  OPENAI_RESPONSES_API_TOOL_CALL_RESPONSE,
  OPENAI_RESPONSES_API_ERROR_RESPONSE,
} from '../test-fixtures';
import { expect } from 'expect';
import { Agent, Runner, tool, OpenAIProvider } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

function createRunner(responses: Record<string, unknown>[], statusCode: number = 200): Runner {
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
  const provider = new OpenAIProvider({ openAIClient: client });
  return new Runner({ modelProvider: provider, tracingDisabled: false });
}

function setCaptureContent(enabled: boolean): void {
  const processor = instrumentation._processor as any;
  if (processor) {
    processor._captureMessageContent = enabled;
  }
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
        (s.attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS] as string[] | undefined)?.includes('tool_calls')
      );
      expect(toolCallSpan).toBeDefined();
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

      const outputMsgs = chatSpan!.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES] as string | undefined;
      expect(outputMsgs).toBeDefined();
      const parsedOutput = JSON.parse(outputMsgs!);
      expect(parsedOutput[0].role).toBe('assistant');
      expect(parsedOutput[0].parts[0].content).toBe('The answer is 4');
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
      expect(chatSpan).toBeDefined();
      expect(chatSpan!.attributes[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeUndefined();
      expect(chatSpan!.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).toBeUndefined();
      expect(chatSpan!.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
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
});
