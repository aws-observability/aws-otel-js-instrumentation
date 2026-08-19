// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  trace,
  Tracer as OtelTracer,
  Span as OtelSpan,
  SpanKind,
  SpanStatusCode,
  Context as OtelContext,
  context,
} from '@opentelemetry/api';
import type {
  TracingProcessor,
  Span as SdkSpan,
  Trace as SdkTrace,
  SpanData,
  GenerationSpanData,
  ResponseSpanData,
  FunctionSpanData,
} from '@openai/agents';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
} from '../common/semconv';
import {
  AttributeMapping,
  contentToParts,
  resolveProviderName,
  serializeToJson,
  toToolAttributeValue,
  tryParseJson,
} from '../common/instrumentation-utils';

interface SpanEntry {
  otelSpan: OtelSpan;
  otelContext: OtelContext;
  isAgentSpan: boolean;
  // For agent spans, tracks whether the initial user input has been captured
  // so later messages do not overwrite it.
  hasCapturedFirstUserMessage: boolean;
}

export class OpenTelemetryTracingProcessor implements TracingProcessor {
  // An adapter class for OpenAI Agents' TracingProcessor to intercept SDK spans
  // and create corresponding OTel spans with OTel GenAI semantic convention attributes.
  // see: https://github.com/openai/openai-agents-js/blob/v0.8.5/packages/agents-core/src/tracing/processor.ts#L16-L53
  private static readonly ATTRIBUTE_MAP: AttributeMapping[] = [
    { from: 'agent.name', to: ATTR_GEN_AI_AGENT_NAME },
    { from: 'agent.output_type', to: ATTR_GEN_AI_OUTPUT_TYPE },
    { from: 'function.name', to: ATTR_GEN_AI_TOOL_NAME },
    { from: 'transcription.model', to: ATTR_GEN_AI_REQUEST_MODEL },
    { from: 'speech.model', to: ATTR_GEN_AI_REQUEST_MODEL },
    { from: '*.type' },
    { from: 'response._response' },
    { from: 'response._input' },
    { from: 'response.response_id' },
    { from: 'function.input' },
    { from: 'function.output' },
    { from: 'generation.model' },
    { from: 'generation.input' },
    { from: 'generation.output' },
    { from: 'generation.usage' },
    { from: 'generation.model_config' },
  ];

  private _tracer: OtelTracer;
  private _captureMessageContent: boolean;
  private _spanMap: Map<string, SpanEntry> = new Map();
  private _disabled: boolean = false;

  constructor(tracer: OtelTracer, captureMessageContent: boolean) {
    this._tracer = tracer;
    this._captureMessageContent = captureMessageContent;
  }

  get disabled(): boolean {
    return this._disabled;
  }

  disable(): void {
    this._disabled = true;
  }

  enable(): void {
    this._disabled = false;
  }

  getOtelContext(spanId: string): OtelContext | undefined {
    return this._spanMap.get(spanId)?.otelContext;
  }

  async onTraceStart(_trace: SdkTrace): Promise<void> {}

  async onTraceEnd(_trace: SdkTrace): Promise<void> {}

  async onSpanStart(sdkSpan: SdkSpan<SpanData>): Promise<void> {
    if (this._disabled) return;

    const existing = this._spanMap.get(sdkSpan.spanId);
    if (existing) return;

    const spanData = sdkSpan.spanData;
    if (!spanData?.type) return;

    const parentContext = (sdkSpan.parentId && this._spanMap.get(sdkSpan.parentId)?.otelContext) || context.active();
    const { name, kind } = this._getSpanNameAndKind(spanData);

    const otelSpan = this._tracer.startSpan(name, { kind }, parentContext);
    this._setStartAttributes(otelSpan, spanData);

    const otelContext = trace.setSpan(parentContext, otelSpan);
    this._spanMap.set(sdkSpan.spanId, {
      otelSpan,
      otelContext,
      isAgentSpan: spanData.type === 'agent',
      hasCapturedFirstUserMessage: false,
    });
  }

  async onSpanEnd(span: SdkSpan<SpanData>): Promise<void> {
    if (this._disabled) return;

    const entry = this._spanMap.get(span.spanId);
    if (!entry) return;

    const { otelSpan } = entry;
    const spanData = span.spanData;

    this._setEndAttributes(otelSpan, spanData, span.parentId);

    if (span.error) {
      otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: span.error.message });
      otelSpan.recordException({ message: span.error.message });
    }

    otelSpan.end();
    this._spanMap.delete(span.spanId);
  }

  async shutdown(): Promise<void> {
    this._spanMap.clear();
  }

  async forceFlush(): Promise<void> {
    this._spanMap.clear();
  }

  private _getSpanNameAndKind(spanData: SpanData): { name: string; kind: SpanKind } {
    const data = spanData as Record<string, any>;
    switch (spanData.type) {
      case 'agent':
        return { name: `${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} ${spanData.name}`, kind: SpanKind.INTERNAL };
      case 'response': {
        const model = ((spanData as ResponseSpanData)._response as Record<string, any> | undefined)?.model;
        const name = model ? `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${model}` : GEN_AI_OPERATION_NAME_VALUE_CHAT;
        return { name, kind: SpanKind.CLIENT };
      }
      case 'generation':
        return { name: GEN_AI_OPERATION_NAME_VALUE_CHAT, kind: SpanKind.CLIENT };
      case 'function':
        return { name: `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${data.name}`, kind: SpanKind.INTERNAL };
      default: {
        const label = data.name ?? data.server ?? data.to_agent;
        const name = label ? `${spanData.type} ${label}` : spanData.type;
        return { name, kind: SpanKind.INTERNAL };
      }
    }
  }

  private _setStartAttributes(otelSpan: OtelSpan, spanData: SpanData): void {
    otelSpan.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, GEN_AI_PROVIDER_NAME_VALUE_OPENAI);

    switch (spanData.type) {
      case 'agent':
        otelSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
        break;
      case 'response':
      case 'generation':
        otelSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
        break;
      case 'function':
        otelSpan.setAttribute(ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL);
        otelSpan.setAttribute(ATTR_GEN_AI_TOOL_TYPE, 'function');
        break;
    }

    this._mapSdkFieldsToAttributes(otelSpan, spanData);
  }

  private _setEndAttributes(otelSpan: OtelSpan, spanData: SpanData, parentId: string | null): void {
    switch (spanData.type) {
      case 'response':
        this._setResponseEndAttributes(otelSpan, spanData, parentId);
        break;
      case 'generation':
        this._setGenerationEndAttributes(otelSpan, spanData, parentId);
        break;
      case 'function':
        this._setFunctionEndAttributes(otelSpan, spanData);
        break;
    }

    this._mapSdkFieldsToAttributes(otelSpan, spanData);
  }

  private _setResponseEndAttributes(otelSpan: OtelSpan, spanData: ResponseSpanData, parentId: string | null): void {
    const response = spanData._response as Record<string, any> | undefined;

    if (spanData.response_id) {
      otelSpan.setAttribute(ATTR_GEN_AI_RESPONSE_ID, spanData.response_id);
    }

    if (!response) return;

    const model = response.model;
    if (model) {
      otelSpan.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, model);
      (otelSpan as any).name = `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${model}`;
      this._propagateModelToAgent(parentId, model);
    }

    if (response.usage) {
      if (response.usage.input_tokens != null) {
        otelSpan.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, response.usage.input_tokens);
      }
      if (response.usage.output_tokens != null) {
        otelSpan.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, response.usage.output_tokens);
      }
    }

    if (response.temperature != null) {
      otelSpan.setAttribute(ATTR_GEN_AI_REQUEST_TEMPERATURE, response.temperature);
    }
    if (response.top_p != null) {
      otelSpan.setAttribute(ATTR_GEN_AI_REQUEST_TOP_P, response.top_p);
    }

    const finishReasons = this._getFinishReasons(response);
    if (finishReasons.length > 0) {
      otelSpan.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, finishReasons);
    }

    if (response.tools && Array.isArray(response.tools)) {
      otelSpan.setAttribute(ATTR_GEN_AI_TOOL_DEFINITIONS, serializeToJson(response.tools));
    }

    if (this._captureMessageContent) {
      if (response.instructions) {
        otelSpan.setAttribute(ATTR_GEN_AI_SYSTEM_INSTRUCTIONS, serializeToJson(contentToParts(response.instructions)));
      }

      const inputMessages = this._formatInputMessages(spanData._input);
      if (inputMessages) {
        otelSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, inputMessages);
      }

      const outputMessages = this._formatOutputMessages(response.output, finishReasons);
      if (outputMessages) {
        otelSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, outputMessages);
      }

      this._propagateMessagesToAgent(parentId, inputMessages, outputMessages);
    }
  }

  private _setGenerationEndAttributes(otelSpan: OtelSpan, spanData: GenerationSpanData, parentId: string | null): void {
    const modelConfig = spanData.model_config;
    const provider = typeof modelConfig?.provider === 'string' ? modelConfig.provider : undefined;
    if (provider) {
      otelSpan.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, resolveProviderName(provider));
    }

    let model = spanData.model;
    if (model) {
      const providerPrefix = provider ? `${provider}:` : undefined;
      if (providerPrefix && model.startsWith(providerPrefix)) {
        model = model.slice(providerPrefix.length);
      }
      otelSpan.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, model);
      (otelSpan as any).name = `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${model}`;
      this._propagateModelToAgent(parentId, model);
    }

    const usage = spanData.usage as Record<string, any> | undefined;
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
    const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;
    if (inputTokens != null) {
      otelSpan.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, inputTokens);
    }
    if (outputTokens != null) {
      otelSpan.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, outputTokens);
    }

    const finishReasons = this._getFinishReasons({ output: spanData.output });
    if (finishReasons.length > 0) {
      otelSpan.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, finishReasons);
    }

    if (modelConfig?.temperature != null) {
      otelSpan.setAttribute(ATTR_GEN_AI_REQUEST_TEMPERATURE, modelConfig.temperature);
    }
    if (modelConfig?.top_p != null) {
      otelSpan.setAttribute(ATTR_GEN_AI_REQUEST_TOP_P, modelConfig.top_p);
    }

    if (this._captureMessageContent) {
      const inputMessages = this._formatInputMessages(spanData.input);
      if (inputMessages) {
        otelSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, inputMessages);
      }

      const outputMessages = this._formatOutputMessages(spanData.output, finishReasons);
      if (outputMessages) {
        otelSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, outputMessages);
      }

      this._propagateMessagesToAgent(parentId, inputMessages, outputMessages);
    }
  }

  private _setFunctionEndAttributes(otelSpan: OtelSpan, spanData: FunctionSpanData): void {
    if (this._captureMessageContent) {
      const input = toToolAttributeValue(spanData.input);
      if (input !== undefined && input !== '') {
        otelSpan.setAttribute(ATTR_GEN_AI_TOOL_CALL_ARGUMENTS, input);
      }
      const output = toToolAttributeValue(spanData.output);
      if (output !== undefined && output !== '') {
        otelSpan.setAttribute(ATTR_GEN_AI_TOOL_CALL_RESULT, output);
      }
    }
  }

  private _mapSdkFieldsToAttributes(otelSpan: OtelSpan, spanData: SpanData): void {
    const type = spanData.type;
    const data = spanData as Record<string, any>;

    for (const field of Object.keys(data)) {
      const value = data[field];
      if (value == null) continue;

      const mapKey = `${type}.${field}`;
      const mapping = OpenTelemetryTracingProcessor.ATTRIBUTE_MAP.find(
        m => m.from === mapKey || m.from === `*.${field}`
      );
      if (mapping && !mapping.to) continue;

      const attrValue = mapping?.transform ? mapping.transform(value, data) : value;
      // for attributes we don't have a equivalent OTel mapping to, prepend open_ai to the attribute
      // name to avoid dropping the data
      const attrName = mapping?.to ?? `open_ai.${mapKey}`;

      if (typeof attrValue === 'string' || typeof attrValue === 'number' || typeof attrValue === 'boolean') {
        otelSpan.setAttribute(attrName, attrValue);
      } else if (Array.isArray(attrValue) && attrValue.every(v => typeof v === 'string')) {
        otelSpan.setAttribute(attrName, attrValue);
      } else {
        otelSpan.setAttribute(attrName, serializeToJson(attrValue));
      }
    }
  }

  private _getFinishReasons(response: Record<string, any>): string[] {
    const incompleteReason = response.incomplete_details?.reason;
    if (typeof incompleteReason === 'string') {
      return [incompleteReason === 'max_output_tokens' ? 'length' : incompleteReason];
    }
    if (response.status === 'failed') return ['error'];
    if (!response.output || !Array.isArray(response.output)) return [];

    const hasToolCalls = response.output.some((item: any) => item.type === 'function_call');
    const hasMessages = response.output.some((item: any) => item.type === 'message');

    if (hasToolCalls) return ['tool_call'];
    if (hasMessages) return ['stop'];
    return [];
  }

  private _formatInputMessages(input: string | Record<string, any>[] | undefined): string | undefined {
    if (!input || !Array.isArray(input)) return undefined;

    const formatted = input.map((item: Record<string, any>) => {
      if (item.type === 'message' || ('role' in item && 'content' in item)) {
        return {
          role: item.role ?? 'user',
          parts: this._formatMessageParts(item.content),
        };
      }
      if (item.type === 'function_call') {
        return {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              id: item.callId ?? item.call_id ?? null,
              name: item.name ?? '',
              arguments: tryParseJson(item.arguments ?? ''),
            },
          ],
        };
      }
      if (item.type === 'function_call_result') {
        return {
          role: 'tool',
          parts: [
            {
              type: 'tool_call_response',
              id: item.callId ?? item.call_id ?? null,
              response: item.output?.text ?? item.output ?? '',
            },
          ],
        };
      }
      return { role: 'user', parts: contentToParts(serializeToJson(item)) };
    });

    return serializeToJson(formatted);
  }

  private _formatOutputMessages(output: any, finishReasons: string[]): string | undefined {
    if (!output || !Array.isArray(output)) return undefined;

    const parts: any[] = [];
    for (const item of output) {
      if (item.type === 'message' && item.content) {
        parts.push(...this._formatMessageParts(item.content));
      } else if (item.type === 'reasoning') {
        const summary = this._formatMessageParts(item.summary).filter(part => part.type === 'reasoning');
        const content = this._formatMessageParts(item.content).filter(part => part.type === 'reasoning');
        const rawContent = this._formatMessageParts(item.rawContent).filter(part => part.type === 'reasoning');
        // Raw reasoning content is only a fallback when no normalized reasoning exists.
        parts.push(...(summary.length > 0 ? summary : content.length > 0 ? content : rawContent));
      } else if (item.type === 'function_call') {
        parts.push({
          type: 'tool_call',
          id: item.callId ?? item.call_id ?? item.id ?? null,
          name: item.name ?? '',
          arguments: tryParseJson(item.arguments ?? ''),
        });
      }
    }

    if (parts.length === 0) return undefined;

    return serializeToJson([
      {
        role: 'assistant',
        parts,
        finish_reason: finishReasons[0] ?? 'stop',
      },
    ]);
  }

  private _formatMessageParts(content: unknown): Array<Record<string, unknown>> {
    const blocks = Array.isArray(content) ? content : [content];
    return blocks.flatMap(block => {
      if (!block || typeof block !== 'object') return contentToParts(block);
      const value = block as Record<string, unknown>;
      if (value.type === 'input_text' || value.type === 'output_text') {
        return contentToParts({ type: 'text', text: value.text });
      }
      if (value.type === 'reasoning_text' || value.type === 'summary_text') {
        return contentToParts({ type: 'reasoning', reasoning: value.text });
      }
      if (value.type === 'reasoning') {
        return contentToParts({ type: 'reasoning', reasoning: value.text });
      }
      if (value.type === 'tool-call') {
        return [
          {
            type: 'tool_call',
            id: value.toolCallId ?? null,
            name: value.toolName ?? '',
            arguments: value.input,
          },
        ];
      }
      if (value.type === 'tool-result') {
        return [
          {
            type: 'tool_call_response',
            id: value.toolCallId ?? null,
            response: value.output,
          },
        ];
      }
      if (value.type === 'file' && typeof value.mediaType === 'string' && value.data != null) {
        const modality = value.mediaType.split('/', 1)[0];
        if (
          value.data instanceof URL ||
          (typeof value.data === 'string' && !value.data.startsWith('data:') && value.data.includes('://'))
        ) {
          return [{ type: 'uri', modality, uri: String(value.data) }];
        }
        if (typeof value.data === 'string' && value.data.startsWith('data:')) {
          return contentToParts({ type: 'image_url', image_url: { url: value.data } });
        }
        return [{ type: 'blob', modality, mime_type: value.mediaType, content: value.data }];
      }
      if (value.type === 'input_image' && typeof value.image === 'string') {
        return contentToParts({ type: 'image_url', image_url: { url: value.image } });
      }
      return contentToParts(value);
    });
  }

  private _propagateModelToAgent(parentId: string | null, model: string): void {
    if (!parentId) return;
    const parentEntry = this._spanMap.get(parentId);
    if (!parentEntry?.isAgentSpan || !parentEntry.otelSpan.isRecording()) return;
    parentEntry.otelSpan.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, model);
  }

  // Propagates the first user input and final assistant output to the parent agent span.
  // Later assistant outputs replace earlier ones so the agent span retains the final response.
  private _propagateMessagesToAgent(
    parentId: string | null,
    inputMessages: string | undefined,
    outputMessages: string | undefined
  ): void {
    if (!parentId) return;
    const parentEntry = this._spanMap.get(parentId);
    if (!parentEntry?.isAgentSpan || !parentEntry.otelSpan.isRecording()) return;

    const findMessageByRole = (
      serializedMessages: string,
      role: string,
      fromEnd: boolean = false
    ): Record<string, unknown> | undefined => {
      const messages = tryParseJson(serializedMessages);
      if (!Array.isArray(messages)) return undefined;

      const orderedMessages = fromEnd ? [...messages].reverse() : messages;
      return orderedMessages.find(
        (message): message is Record<string, unknown> =>
          typeof message === 'object' && message !== null && !Array.isArray(message) && message.role === role
      );
    };

    if (!parentEntry.hasCapturedFirstUserMessage && inputMessages) {
      const firstUserMessage = findMessageByRole(inputMessages, 'user');
      if (firstUserMessage) {
        parentEntry.otelSpan.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, serializeToJson([firstUserMessage]));
        parentEntry.hasCapturedFirstUserMessage = true;
      }
    }

    if (outputMessages) {
      const lastAssistantMessage = findMessageByRole(outputMessages, 'assistant', true);
      if (lastAssistantMessage) {
        parentEntry.otelSpan.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, serializeToJson([lastAssistantMessage]));
      }
    }
  }
}
