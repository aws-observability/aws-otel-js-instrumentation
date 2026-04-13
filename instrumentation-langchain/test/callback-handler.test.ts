// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTelCallbackHandler } from '../src/callback-handler';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_METADATA,
} from '../src/semconv';

describe('OTelCallbackHandler', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let handler: OTelCallbackHandler;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test-tracer');
    handler = new OTelCallbackHandler(tracer);
  });

  afterEach(() => {
    exporter.reset();
    sinon.restore();
  });

  describe('handleChatModelStart', () => {
    it('creates span with correct attributes and SpanKind.CLIENT', () => {
      const runId = 'run-123';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };
      const messages = [[{ type: 'human', content: 'Hello' }]];
      const metadata = { model: 'anthropic.claude-v4-sonnet' };

      handler.handleChatModelStart(llm, messages, runId, undefined, {}, [], metadata);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);

      const span = spans[0];
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.name).toBe('chat anthropic.claude-v4-sonnet');
      expect(span.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe('chat');
      expect(span.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe('anthropic.claude-v4-sonnet');
      expect(span.attributes[ATTR_GEN_AI_SYSTEM]).toBe('aws.bedrock');
    });

    it('extracts openai provider correctly', () => {
      const runId = 'run-openai';
      const llm = { id: ['langchain', 'llms', 'openai'] };

      handler.handleChatModelStart(llm, [[]], runId, undefined, { invocation_params: { model: 'gpt-4o' } });
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[ATTR_GEN_AI_SYSTEM]).toBe('openai');
    });

    it('extracts anthropic provider correctly', () => {
      const runId = 'run-anthropic';
      const llm = { id: ['langchain', 'llms', 'anthropic'] };

      handler.handleChatModelStart(llm, [[]], runId, undefined, { invocation_params: { model: 'claude-4-sonnet' } });
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[ATTR_GEN_AI_SYSTEM]).toBe('anthropic');
    });

    it('uses last id element for unrecognized provider', () => {
      const runId = 'run-unknown';
      const llm = { id: ['langchain', 'llms', 'custom'] };

      handler.handleChatModelStart(llm, [[]], runId);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[ATTR_GEN_AI_SYSTEM]).toBe('custom');
    });
  });

  describe('handleLLMEnd', () => {
    it('sets token usage attributes when provided via llmOutput', () => {
      const runId = 'run-tokens';
      const llm = { id: ['langchain', 'llms', 'openai'] };

      handler.handleChatModelStart(llm, [[]], runId);
      handler.handleLLMEnd({
        generations: [[{
          text: 'response',
          message: {
            kwargs: {
              content: 'response',
              usage_metadata: { input_tokens: 100, output_tokens: 50 }
            }
          }
        }]]
      }, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
      expect(spans[0].attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(50);
    });
  });

  describe('handleLLMError', () => {
    it('records exception and sets ERROR status', () => {
      const runId = 'run-error';
      const llm = { id: ['langchain', 'llms', 'openai'] };
      const error = new Error('API rate limit exceeded');

      handler.handleChatModelStart(llm, [[]], runId, undefined, { invocation_params: { model: 'gpt-4o' } });
      handler.handleLLMError(error, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBe('API rate limit exceeded');
      expect(spans[0].events.length).toBe(1);
      expect(spans[0].events[0].name).toBe('exception');
    });
  });

  describe('handleToolStart', () => {
    it('creates child span with ATTR_GEN_AI_TOOL_NAME', () => {
      const parentRunId = 'parent-run';
      const toolRunId = 'tool-run';
      const llm = { id: ['langchain', 'llms', 'openai'] };

      handler.handleChatModelStart(llm, [[]], parentRunId, undefined, { invocation_params: { model: 'gpt-4o' } });
      handler.handleToolStart({ name: 'calculator' }, '2+2', toolRunId, parentRunId);
      handler.handleToolEnd('4', toolRunId);
      handler.handleLLMEnd({ llmOutput: {} }, parentRunId);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(2);

      const toolSpan = spans.find(s => s.name.includes('calculator'));
      expect(toolSpan).toBeDefined();
      expect(toolSpan!.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe('calculator');
      expect(toolSpan!.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe('execute_tool');
      expect(toolSpan!.kind).toBe(SpanKind.INTERNAL);
    });
  });

  describe('handleChainStart/End', () => {
    it('creates chain span with correct attributes', () => {
      const runId = 'chain-run';

      handler.handleChainStart({ name: 'RetrievalQA' }, {}, runId);
      handler.handleChainEnd({}, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('chain RetrievalQA');
      expect(spans[0].attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe('chain');
      expect(spans[0].kind).toBe(SpanKind.INTERNAL);
    });
  });

  describe('parent-child relationships', () => {
    it('maintains correct span hierarchy via runId mapping', () => {
      const chainRunId = 'chain-1';
      const llmRunId = 'llm-1';
      const llm = { id: ['langchain', 'llms', 'openai'] };

      handler.handleChainStart({ name: 'TestChain' }, {}, chainRunId);
      handler.handleChatModelStart(llm, [[]], llmRunId, chainRunId, {}, [], { model: 'gpt-4o' });
      handler.handleLLMEnd({ llmOutput: {} }, llmRunId);
      handler.handleChainEnd({}, chainRunId);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(2);

      const chainSpan = spans.find(s => s.name.includes('TestChain'));
      const llmSpan = spans.find(s => s.name.includes('gpt-4o'));

      expect(chainSpan).toBeDefined();
      expect(llmSpan).toBeDefined();
      // Both spans should be created - LLM span should be child of chain span
      // The parent-child relationship is established via the context passed to startSpan
      expect(chainSpan!.spanContext().traceId).toBe(llmSpan!.spanContext().traceId);
    });
  });

  describe('metadata attribute', () => {
    it('extracts langgraph metadata as JSON string', () => {
      const runId = 'langgraph-run';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };
      const metadata = { langgraph_node: 'agent', langgraph_step: 1 };

      handler.handleChatModelStart(llm, [[]], runId, undefined, {}, [], metadata);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      const metadataAttr = JSON.parse(spans[0].attributes[ATTR_METADATA] as string);
      expect(metadataAttr.langgraph_node).toBe('agent');
      expect(metadataAttr.langgraph_step).toBe(1);
    });

    it('handles missing langgraph metadata gracefully', () => {
      const runId = 'no-langgraph';
      const llm = { id: ['langchain', 'llms', 'openai'] };

      handler.handleChatModelStart(llm, [[]], runId, undefined, {}, [], {});
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[ATTR_METADATA]).toBeUndefined();
    });

    it('sets metadata attribute on chain spans', () => {
      const runId = 'chain-langgraph';
      const metadata = { langgraph_node: 'tools', langgraph_step: 2 };

      handler.handleChainStart({ name: 'ToolNode' }, {}, runId, undefined, [], metadata);
      handler.handleChainEnd({}, runId);

      const spans = exporter.getFinishedSpans();
      const metadataAttr = JSON.parse(spans[0].attributes[ATTR_METADATA] as string);
      expect(metadataAttr.langgraph_node).toBe('tools');
      expect(metadataAttr.langgraph_step).toBe(2);
    });

    it('sets metadata attribute on tool spans', () => {
      const runId = 'tool-langgraph';
      const metadata = { langgraph_node: 'tools', langgraph_step: 3 };

      handler.handleToolStart({ name: 'web_search' }, '{"query":"test"}', runId, undefined, [], metadata);
      handler.handleToolEnd('results', runId);

      const spans = exporter.getFinishedSpans();
      const metadataAttr = JSON.parse(spans[0].attributes[ATTR_METADATA] as string);
      expect(metadataAttr.langgraph_node).toBe('tools');
      expect(metadataAttr.langgraph_step).toBe(3);
    });
  });

  describe('message normalization', () => {
    it('normalizes LangChain lc-serialized HumanMessage to OTel format', () => {
      const runId = 'lc-human';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };
      const messages = [[{
        lc: 1,
        type: 'constructor',
        id: ['langchain_core', 'messages', 'HumanMessage'],
        kwargs: { content: 'what can you do' }
      }]];

      handler.handleChatModelStart(llm, messages, runId);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      const inputMessages = JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string);
      expect(inputMessages).toEqual([
        { role: 'user', parts: [{ type: 'text', content: 'what can you do' }] }
      ]);
    });

    it('normalizes multiple message types correctly', () => {
      const runId = 'multi-msg';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };
      const messages = [[
        { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'SystemMessage'], kwargs: { content: 'You are helpful' } },
        { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'HumanMessage'], kwargs: { content: 'Hello' } },
        { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'AIMessage'], kwargs: { content: 'Hi there' } },
      ]];

      handler.handleChatModelStart(llm, messages, runId);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      const inputMessages = JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string);
      expect(inputMessages).toEqual([
        { role: 'system', parts: [{ type: 'text', content: 'You are helpful' }] },
        { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
        { role: 'assistant', parts: [{ type: 'text', content: 'Hi there' }] },
      ]);
    });

    it('handles direct format messages (type: human/ai)', () => {
      const runId = 'direct-format';
      const llm = { id: ['langchain', 'llms', 'openai'] };
      const messages = [[
        { type: 'human', content: 'Hello' },
        { type: 'ai', content: 'Hi!' },
      ]];

      handler.handleChatModelStart(llm, messages, runId);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      const inputMessages = JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string);
      expect(inputMessages).toEqual([
        { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
        { role: 'assistant', parts: [{ type: 'text', content: 'Hi!' }] },
      ]);
    });

    it('extracts text from content blocks array', () => {
      const runId = 'content-blocks';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };
      const messages = [[{
        lc: 1,
        type: 'constructor',
        id: ['langchain_core', 'messages', 'AIMessage'],
        kwargs: {
          content: [
            { type: 'text', text: 'First part' },
            { type: 'tool_use', id: 'tool1' },
            { type: 'text', text: 'Second part' },
          ]
        }
      }]];

      handler.handleChatModelStart(llm, messages, runId);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      const inputMessages = JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string);
      expect(inputMessages).toEqual([
        { role: 'assistant', parts: [{ type: 'text', content: 'First part\nSecond part' }] }
      ]);
    });

    it('normalizes output messages to OTel format with string content', () => {
      const runId = 'output-string';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };

      handler.handleChatModelStart(llm, [[]], runId);
      handler.handleLLMEnd({
        generations: [[{ text: 'Hello, I am an AI assistant.' }]]
      }, runId);

      const spans = exporter.getFinishedSpans();
      const outputMessages = JSON.parse(spans[0].attributes['gen_ai.output.messages'] as string);
      expect(outputMessages).toEqual([
        { role: 'assistant', parts: [{ type: 'text', content: 'Hello, I am an AI assistant.' }] }
      ]);
    });

    it('normalizes output messages with content blocks array', () => {
      const runId = 'output-blocks';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };

      handler.handleChatModelStart(llm, [[]], runId);
      handler.handleLLMEnd({
        generations: [[{
          message: {
            kwargs: {
              content: [
                { type: 'text', text: 'Part 1' },
                { type: 'text', text: 'Part 2' },
              ]
            }
          }
        }]]
      }, runId);

      const spans = exporter.getFinishedSpans();
      const outputMessages = JSON.parse(spans[0].attributes['gen_ai.output.messages'] as string);
      expect(outputMessages).toEqual([
        { role: 'assistant', parts: [{ type: 'text', content: 'Part 1\nPart 2' }] }
      ]);
    });

    it('handles ToolMessage role correctly', () => {
      const runId = 'tool-msg';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };
      const messages = [[{
        lc: 1,
        type: 'constructor',
        id: ['langchain_core', 'messages', 'ToolMessage'],
        kwargs: { content: '{"result": "success"}' }
      }]];

      handler.handleChatModelStart(llm, messages, runId);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      const inputMessages = JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string);
      expect(inputMessages).toEqual([
        { role: 'tool', parts: [{ type: 'text', content: '{"result": "success"}' }] }
      ]);
    });

    it('handles AIMessageChunk role correctly', () => {
      const runId = 'ai-chunk';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };
      const messages = [[{
        lc: 1,
        type: 'constructor',
        id: ['langchain_core', 'messages', 'AIMessageChunk'],
        kwargs: { content: 'streaming response' }
      }]];

      handler.handleChatModelStart(llm, messages, runId);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      const inputMessages = JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string);
      expect(inputMessages).toEqual([
        { role: 'assistant', parts: [{ type: 'text', content: 'streaming response' }] }
      ]);
    });

    it('skips messages with empty content', () => {
      const runId = 'empty-content';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };
      const messages = [[
        { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'HumanMessage'], kwargs: { content: '' } },
        { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'HumanMessage'], kwargs: { content: 'valid' } },
      ]];

      handler.handleChatModelStart(llm, messages, runId);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      const inputMessages = JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string);
      expect(inputMessages).toEqual([
        { role: 'user', parts: [{ type: 'text', content: 'valid' }] }
      ]);
    });
  });

  describe('handleLLMStart', () => {
    it('normalizes prompts to OTel format with parts', () => {
      const runId = 'llm-start';
      const llm = { id: ['langchain', 'llms', 'openai'], kwargs: { model: 'gpt-4o-mini' } };
      const prompts = ['What is 2+2?', 'Explain quantum physics'];

      handler.handleLLMStart(llm, prompts, runId);
      handler.handleLLMEnd({ llmOutput: {} }, runId);

      const spans = exporter.getFinishedSpans();
      const inputMessages = JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string);
      expect(inputMessages).toEqual([
        { role: 'user', parts: [{ type: 'text', content: 'What is 2+2?' }] },
        { role: 'user', parts: [{ type: 'text', content: 'Explain quantum physics' }] },
      ]);
    });
  });

  describe('handleLLMEnd comprehensive', () => {
    it('extracts token usage from usage_metadata in kwargs', () => {
      const runId = 'tokens-kwargs';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };

      handler.handleChatModelStart(llm, [[]], runId);
      handler.handleLLMEnd({
        generations: [[{
          text: 'response',
          message: {
            kwargs: {
              content: 'response',
              usage_metadata: { input_tokens: 100, output_tokens: 50 }
            }
          }
        }]]
      }, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
      expect(spans[0].attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(50);
    });

    it('extracts finish reason from response_metadata', () => {
      const runId = 'finish-reason';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };

      handler.handleChatModelStart(llm, [[]], runId);
      handler.handleLLMEnd({
        generations: [[{
          text: 'response',
          message: {
            kwargs: {
              content: 'response',
              response_metadata: { stopReason: 'end_turn' }
            }
          }
        }]]
      }, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes['gen_ai.response.finish_reasons']).toBe('["end_turn"]');
    });

    it('extracts response ID from kwargs.id', () => {
      const runId = 'response-id';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };

      handler.handleChatModelStart(llm, [[]], runId);
      handler.handleLLMEnd({
        generations: [[{
          text: 'response',
          message: {
            kwargs: {
              content: 'response',
              id: 'req-12345-abcde'
            }
          }
        }]]
      }, runId);

      const spans = exporter.getFinishedSpans();
      expect(spans[0].attributes['gen_ai.response.id']).toBe('req-12345-abcde');
    });

    it('extracts tool calls from kwargs', () => {
      const runId = 'tool-calls';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };

      handler.handleChatModelStart(llm, [[]], runId);
      handler.handleLLMEnd({
        generations: [[{
          text: 'I will search for that',
          message: {
            kwargs: {
              content: [{ type: 'text', text: 'I will search for that' }],
              tool_calls: [
                { id: 'tool1', name: 'web_search', args: { query: 'test' }, type: 'tool_call' }
              ]
            }
          }
        }]]
      }, runId);

      const spans = exporter.getFinishedSpans();
      const toolCalls = JSON.parse(spans[0].attributes['gen_ai.output.tool_calls'] as string);
      expect(toolCalls).toEqual([
        { id: 'tool1', name: 'web_search', args: { query: 'test' }, type: 'tool_call' }
      ]);
    });
  });

  describe('stack-based parent tracking', () => {
    it('maintains hierarchy when parentRunId is not provided (LangGraph streaming)', () => {
      const chainRunId = 'chain-root';
      const llmRunId = 'llm-child';
      const llm = { id: ['langchain', 'llms', 'bedrock'] };

      // Simulate LangGraph behavior: parentRunId is undefined
      handler.handleChainStart({ name: 'LangGraph' }, {}, chainRunId);
      handler.handleChatModelStart(llm, [[]], llmRunId, undefined, {}, [], { langgraph_node: 'agent' });
      handler.handleLLMEnd({ llmOutput: {} }, llmRunId);
      handler.handleChainEnd({}, chainRunId);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(2);

      const chainSpan = spans.find(s => s.name.includes('LangGraph'));
      const llmSpan = spans.find(s => s.name.includes('pending'));

      expect(chainSpan).toBeDefined();
      expect(llmSpan).toBeDefined();
      // Both should share the same trace (stack-based tracking creates hierarchy)
      expect(chainSpan!.spanContext().traceId).toBe(llmSpan!.spanContext().traceId);
    });
  });
});
