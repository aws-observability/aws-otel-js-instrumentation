// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Context, SpanKind } from '@opentelemetry/api';
import { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
  ATTR_GEN_AI_REQUEST_STOP_SEQUENCES,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_K,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
  GEN_AI_OUTPUT_TYPE_VALUE_JSON,
  GEN_AI_OUTPUT_TYPE_VALUE_TEXT,
} from '../common/semconv';
import { PROVIDER_MAP, serializeToJson } from '../common/instrumentation-utils';
import { LIB_VERSION } from '../../version';
import { INSTRUMENTATION_NAME } from './instrumentation';
import { AttributeMapping } from '../common/instrumentation-utils';

export class VercelAISpanProcessor implements SpanProcessor {
  // Span processor that translates VercelAI span attributes into OTel GenAI semantic conventions.

  // Vercel AI does not record whether a request was configured as an agentic workflow in its span attributes.
  // We detect agents by tracking child spans if it either has tool use or multiple LLM calls.
  private _spanIdToCounts: Map<string, { llmCalls: number; toolCalls: number }> = new Map();

  private static readonly ATTRIBUTE_MAP: AttributeMapping[] = [
    {
      from: 'ai.model.provider',
      to: ATTR_GEN_AI_PROVIDER_NAME,
      transform: (v: string) => VercelAISpanProcessor.mapProviderName(v),
    },
    { from: 'ai.model.id', to: ATTR_GEN_AI_REQUEST_MODEL },
    { from: 'ai.telemetry.functionId', to: ATTR_GEN_AI_AGENT_NAME },
    { from: 'ai.usage.inputTokens', to: ATTR_GEN_AI_USAGE_INPUT_TOKENS },
    { from: 'ai.usage.promptTokens', to: ATTR_GEN_AI_USAGE_INPUT_TOKENS },
    { from: 'ai.usage.tokens', to: ATTR_GEN_AI_USAGE_INPUT_TOKENS },
    { from: 'ai.usage.outputTokens', to: ATTR_GEN_AI_USAGE_OUTPUT_TOKENS },
    { from: 'ai.usage.completionTokens', to: ATTR_GEN_AI_USAGE_OUTPUT_TOKENS },
    { from: 'ai.usage.inputTokenDetails.cacheReadTokens', to: ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS },
    { from: 'ai.usage.inputTokenDetails.cacheWriteTokens', to: ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS },
    {
      from: 'ai.response.finishReason',
      to: ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
      transform: (v: string) => [VercelAISpanProcessor.mapFinishReason(v)],
    },
    { from: 'ai.response.id', to: ATTR_GEN_AI_RESPONSE_ID },
    { from: 'ai.response.model', to: ATTR_GEN_AI_RESPONSE_MODEL },
    { from: 'ai.settings.maxTokens', to: ATTR_GEN_AI_REQUEST_MAX_TOKENS },
    { from: 'ai.settings.maxOutputTokens', to: ATTR_GEN_AI_REQUEST_MAX_TOKENS },
    { from: 'ai.settings.temperature', to: ATTR_GEN_AI_REQUEST_TEMPERATURE },
    { from: 'ai.settings.topP', to: ATTR_GEN_AI_REQUEST_TOP_P },
    { from: 'ai.settings.topK', to: ATTR_GEN_AI_REQUEST_TOP_K },
    { from: 'ai.settings.frequencyPenalty', to: ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY },
    { from: 'ai.settings.presencePenalty', to: ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY },
    { from: 'ai.settings.stopSequences', to: ATTR_GEN_AI_REQUEST_STOP_SEQUENCES },
    {
      from: 'ai.prompt.messages',
      to: ATTR_GEN_AI_INPUT_MESSAGES,
      transform: (v: string) => VercelAISpanProcessor.formatInputMessages(v),
    },
    {
      from: 'ai.prompt',
      to: ATTR_GEN_AI_INPUT_MESSAGES,
      transform: (v: string) => VercelAISpanProcessor.formatInputMessages(v),
    },
    {
      from: 'ai.response.text',
      to: ATTR_GEN_AI_OUTPUT_MESSAGES,
      transform: (v: string, attrs: Record<string, any>) => VercelAISpanProcessor.formatOutputMessages(v, attrs),
    },
    {
      from: 'ai.response.object',
      to: ATTR_GEN_AI_OUTPUT_MESSAGES,
      transform: (v: string, attrs: Record<string, any>) => VercelAISpanProcessor.formatOutputMessages(v, attrs),
    },
    {
      from: 'ai.prompt.tools',
      to: ATTR_GEN_AI_TOOL_DEFINITIONS,
      transform: (v: any) => VercelAISpanProcessor.formatToolDefinitions(v),
    },
    { from: 'ai.toolCall.name', to: ATTR_GEN_AI_TOOL_NAME },
    { from: 'ai.toolCall.id', to: ATTR_GEN_AI_TOOL_CALL_ID },
    {
      from: 'ai.toolCall.args',
      to: ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
      transform: (v: string) => VercelAISpanProcessor.unwrapJsonString(v),
    },
    {
      from: 'ai.toolCall.result',
      to: ATTR_GEN_AI_TOOL_CALL_RESULT,
      transform: (v: string) => VercelAISpanProcessor.unwrapJsonString(v),
    },
  ];

  private static readonly OPERATION_MAP: Record<string, string> = {
    'ai.generateObject': GEN_AI_OPERATION_NAME_VALUE_CHAT,
    'ai.streamObject': GEN_AI_OPERATION_NAME_VALUE_CHAT,
    'ai.generateText.doGenerate': GEN_AI_OPERATION_NAME_VALUE_CHAT,
    'ai.generateText.doStream': GEN_AI_OPERATION_NAME_VALUE_CHAT,
    'ai.streamText.doStream': GEN_AI_OPERATION_NAME_VALUE_CHAT,
    'ai.generateObject.doGenerate': GEN_AI_OPERATION_NAME_VALUE_CHAT,
    'ai.streamObject.doStream': GEN_AI_OPERATION_NAME_VALUE_CHAT,
    'ai.embed': GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
    'ai.embed.doEmbed': GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
    'ai.embedMany': GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
    'ai.embedMany.doEmbed': GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS,
    'ai.toolCall': GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  };

  forceFlush(): Promise<void> {
    this._spanIdToCounts.clear();
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this._spanIdToCounts.clear();
    return Promise.resolve();
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    // https://github.com/vercel/ai/blob/5d0f18e52ed8e43e9916394aaf721585e0479d36/packages/otel/src/get-tracer.ts#L19
    if (span.instrumentationScope?.name !== 'ai') return;


    const attrs = span.attributes;
    const operationId = attrs['ai.operationId'] as string | undefined;

    if (!operationId || !operationId.startsWith('ai.')) return;

    (span as any).instrumentationScope = { name: INSTRUMENTATION_NAME, version: LIB_VERSION };

    if (
      operationId === 'ai.generateText.doGenerate' ||
      operationId === 'ai.streamText.doStream' ||
      operationId === 'ai.toolCall'
    ) {
      const parentSpanId = span.parentSpanContext?.spanId;
      if (parentSpanId) {
        const signals = this._spanIdToCounts.get(parentSpanId) ?? { llmCalls: 0, toolCalls: 0 };
        if (operationId === 'ai.toolCall') {
          signals.toolCalls++;
        } else {
          signals.llmCalls++;
        }
        this._spanIdToCounts.set(parentSpanId, signals);
      }
    }

    const mutableAttrs = attrs as Record<string, any>;

    if (!mutableAttrs[ATTR_GEN_AI_OUTPUT_TYPE]) {
      const outputType = VercelAISpanProcessor.inferOutputType(operationId);
      if (outputType) {
        mutableAttrs[ATTR_GEN_AI_OUTPUT_TYPE] = outputType;
      }
    }

    for (const mapping of VercelAISpanProcessor.ATTRIBUTE_MAP) {
      if (!mapping.to) continue;
      const value = attrs[mapping.from];
      if (value != null && !mutableAttrs[mapping.to]) {
        const mapped = mapping.transform ? mapping.transform(value, mutableAttrs) : value;
        if (mapped != null) {
          mutableAttrs[mapping.to] = mapped;
        }
      }
    }

    if (operationId === 'ai.generateText' || operationId === 'ai.streamText') {
      mutableAttrs[ATTR_GEN_AI_OPERATION_NAME] = this.isAgentSpan(span)
        ? GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT
        : GEN_AI_OPERATION_NAME_VALUE_CHAT;
    } else if (operationId === 'ai.toolCall') {
      mutableAttrs[ATTR_GEN_AI_OPERATION_NAME] = GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL;
      mutableAttrs[ATTR_GEN_AI_TOOL_TYPE] = 'function';
    } else {
      const opName = VercelAISpanProcessor.OPERATION_MAP[operationId];
      if (opName) {
        mutableAttrs[ATTR_GEN_AI_OPERATION_NAME] = opName;
      }
    }

    const opName = mutableAttrs[ATTR_GEN_AI_OPERATION_NAME] as string | undefined;
    if (
      opName === GEN_AI_OPERATION_NAME_VALUE_CHAT ||
      opName === GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS ||
      opName === GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION ||
      opName === GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT ||
      opName === GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL
    ) {
      (span as any).kind = SpanKind.CLIENT;
    } else if (
      opName === GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL ||
      opName === GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT
    ) {
      (span as any).kind = SpanKind.INTERNAL;
    }


    const spanName = VercelAISpanProcessor.createSpanName(mutableAttrs);
    if (spanName) {
      (span as any).name = spanName;
    }

    for (const key of Object.keys(mutableAttrs)) {
      if (
        (key.startsWith('ai.') && !key.startsWith('ai.telemetry.metadata.')) ||
        key === 'operation.name' ||
        key === 'resource.name'
      ) {
        delete mutableAttrs[key];
      }
    }
  }

  /**
   * Determines if a span represents an agent invocation. Per OTel GenAI semantic conventions,
   * "[the] combination of reasoning, logic, and access to external information that are all
   * connected to a Generative AI model invokes the concept of an agent."
   * See: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
   *
   * We detect this if the LLM used any tools or made more than one LLM call.
   */
  private isAgentSpan(span: ReadableSpan): boolean {
    const spanId = span.spanContext().spanId;
    const signals = this._spanIdToCounts.get(spanId);
    this._spanIdToCounts.delete(spanId);
    if (!signals) return false;
    return signals.toolCalls > 0 || signals.llmCalls > 1;
  }

  private static formatInputMessages(value: string): string | undefined {
    try {
      const messages = typeof value === 'string' ? JSON.parse(value) : value;
      if (!Array.isArray(messages)) return value;
      const formatted = messages.map((msg: any) => {
        const parts: Array<Record<string, unknown>> = [];
        if (typeof msg.content === 'string') {
          parts.push({ type: 'text', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              parts.push({ type: 'text', content: part.text ?? part.content ?? '' });
            } else if (part.type === 'tool-call' || part.type === 'tool_call') {
              parts.push({
                type: 'tool_call',
                id: part.toolCallId ?? part.id ?? null,
                name: part.toolName ?? part.name ?? '',
                arguments:
                  typeof part.args === 'string' ? VercelAISpanProcessor.unwrapJsonString(part.args) : part.args,
              });
            } else if (part.type === 'tool-result' || part.type === 'tool_call_response') {
              parts.push({
                type: 'tool_call_response',
                id: part.toolCallId ?? part.id ?? null,
                response: part.result ?? part.response ?? '',
              });
            } else {
              parts.push(part);
            }
          }
        }
        return { role: msg.role, parts };
      });
      return serializeToJson(formatted);
    } catch {
      return value;
    }
  }

  private static formatOutputMessages(value: string, attrs: Record<string, any>): string {
    const finishReason =
      typeof attrs['ai.response.finishReason'] === 'string'
        ? VercelAISpanProcessor.mapFinishReason(attrs['ai.response.finishReason'])
        : 'stop';
    return serializeToJson([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: value }],
        finish_reason: finishReason,
      },
    ]);
  }

  private static formatToolDefinitions(tools: any): string | undefined {
    if (!Array.isArray(tools)) return undefined;
    const parsed = tools.map((t: string) => {
      try {
        const def = JSON.parse(t);
        const result: Record<string, any> = {
          type: def.type || 'function',
          name: def.name,
        };
        if (def.description) result.description = def.description;
        if (def.inputSchema) {
          const { $schema, additionalProperties, ...params } = def.inputSchema;
          result.parameters = params;
        }
        return result;
      } catch {
        return t;
      }
    });
    return serializeToJson(parsed);
  }

  private static createSpanName(attrs: Record<string, any>): string | undefined {
    const op = attrs[ATTR_GEN_AI_OPERATION_NAME] as string | undefined;
    if (!op) return undefined;

    if (op === GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT) {
      const agent = attrs[ATTR_GEN_AI_AGENT_NAME] as string | undefined;
      return agent ? `${op} ${agent}` : op;
    }

    if (op === GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL) {
      const tool = attrs[ATTR_GEN_AI_TOOL_NAME] as string | undefined;
      return tool ? `${op} ${tool}` : op;
    }

    const model = attrs[ATTR_GEN_AI_REQUEST_MODEL] as string | undefined;
    return model ? `${op} ${model}` : op;
  }

  private static mapFinishReason(reason: string): string {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content-filter':
        return 'content_filter';
      case 'tool-calls':
        return 'tool_call';
      case 'error':
        return 'error';
      case 'other':
      case 'unknown':
        return 'stop';
      default:
        return reason;
    }
  }

  private static mapProviderName(provider: string): string {
    if (!provider) return provider;
    const lower = provider.toLowerCase();

    if (PROVIDER_MAP[lower]) return PROVIDER_MAP[lower];

    for (const [prefix, mapped] of Object.entries(PROVIDER_MAP)) {
      if (lower.startsWith(prefix + '.') || lower.startsWith(prefix + '-')) {
        return mapped;
      }
    }

    return provider;
  }

  private static inferOutputType(operationId: string): string | undefined {
    if (operationId.startsWith('ai.generateText') || operationId.startsWith('ai.streamText')) {
      return GEN_AI_OUTPUT_TYPE_VALUE_TEXT;
    }
    if (operationId.startsWith('ai.generateObject') || operationId.startsWith('ai.streamObject')) {
      return GEN_AI_OUTPUT_TYPE_VALUE_JSON;
    }
    return undefined;
  }

  private static unwrapJsonString(value: string): string {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed === 'object' && parsed !== null) return JSON.stringify(parsed);
      return value;
    } catch {
      return value;
    }
  }
}
