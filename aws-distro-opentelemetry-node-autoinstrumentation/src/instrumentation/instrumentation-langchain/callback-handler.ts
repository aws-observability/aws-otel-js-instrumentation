// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, trace, Tracer, Span, SpanKind, SpanStatusCode, Context as OtelContext } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STOP_SEQUENCES,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
  ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
  ATTR_GEN_AI_REQUEST_TOP_K,
  ATTR_GEN_AI_TOOL_DESCRIPTION,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_ERROR_TYPE,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
  GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
  GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
  GEN_AI_PROVIDER_NAME_VALUE_COHERE,
  GEN_AI_PROVIDER_NAME_VALUE_DEEPSEEK,
  GEN_AI_PROVIDER_NAME_VALUE_GCP_GEMINI,
  GEN_AI_PROVIDER_NAME_VALUE_GCP_GEN_AI,
  GEN_AI_PROVIDER_NAME_VALUE_GCP_VERTEX_AI,
  GEN_AI_PROVIDER_NAME_VALUE_GROQ,
  GEN_AI_PROVIDER_NAME_VALUE_MISTRAL_AI,
  GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
  GEN_AI_PROVIDER_NAME_VALUE_PERPLEXITY,
  GEN_AI_PROVIDER_NAME_VALUE_X_AI,
} from '@opentelemetry/semantic-conventions/incubating';
import type { Serialized } from '@langchain/core/load/serializable';
import type { ChatGeneration, LLMResult } from '@langchain/core/outputs';
import type { ChainValues } from '@langchain/core/utils/types';
import type { BaseMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { isAIMessage } from '@langchain/core/messages';

const LANGGRAPH_STEP_SPAN_ATTR = 'langgraph.step';
const LANGGRAPH_NODE_SPAN_ATTR = 'langgraph.node';

const PROVIDER_MAP: Record<string, string> = {
  bedrock: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  amazon_bedrock: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  aws: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  langchain_aws: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  openai: GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
  anthropic: GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
  claude: GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
  azure: GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
  azure_openai: GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
  google: GEN_AI_PROVIDER_NAME_VALUE_GCP_GEN_AI,
  langchain_google_genai: GEN_AI_PROVIDER_NAME_VALUE_GCP_GEN_AI,
  vertex: GEN_AI_PROVIDER_NAME_VALUE_GCP_VERTEX_AI,
  vertexai: GEN_AI_PROVIDER_NAME_VALUE_GCP_VERTEX_AI,
  gemini: GEN_AI_PROVIDER_NAME_VALUE_GCP_GEMINI,
  cohere: GEN_AI_PROVIDER_NAME_VALUE_COHERE,
  langchain_cohere: GEN_AI_PROVIDER_NAME_VALUE_COHERE,
  mistral: GEN_AI_PROVIDER_NAME_VALUE_MISTRAL_AI,
  mistralai: GEN_AI_PROVIDER_NAME_VALUE_MISTRAL_AI,
  groq: GEN_AI_PROVIDER_NAME_VALUE_GROQ,
  langchain_groq: GEN_AI_PROVIDER_NAME_VALUE_GROQ,
  deepseek: GEN_AI_PROVIDER_NAME_VALUE_DEEPSEEK,
  langchain_deepseek: GEN_AI_PROVIDER_NAME_VALUE_DEEPSEEK,
  perplexity: GEN_AI_PROVIDER_NAME_VALUE_PERPLEXITY,
  xai: GEN_AI_PROVIDER_NAME_VALUE_X_AI,
  langchain_xai: GEN_AI_PROVIDER_NAME_VALUE_X_AI,
};

interface SpanEntry {
  span?: Span;
  context: OtelContext;
  agentSpan?: Span;
}

export class OpenTelemetryCallbackHandler extends BaseCallbackHandler {
  name: string = 'otel-callback-handler';
  tracer: Tracer;
  captureMessageContent: boolean;
  shouldSuppressInternalChains: boolean;
  runIdToSpanMap: Map<string, SpanEntry> = new Map();

  constructor(tracer: Tracer, captureMessageContent: boolean = false, shouldSuppressInternalChains: boolean = true) {
    super();
    this.tracer = tracer;
    this.captureMessageContent = captureMessageContent;
    this.shouldSuppressInternalChains = shouldSuppressInternalChains;
  }

  override handleChatModelStart(
    serialized: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>
  ): void {
    const config = OpenTelemetryCallbackHandler._getSerializedConfig(serialized) ?? {};
    const modelName = OpenTelemetryCallbackHandler._extractModelId(extraParams, config, metadata, serialized);
    const provider = OpenTelemetryCallbackHandler._extractModelProvider(serialized, extraParams, metadata);
    const spanName = modelName ? `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${modelName}` : GEN_AI_OPERATION_NAME_VALUE_CHAT;

    const span = this._startSpan(runId, parentRunId, spanName, SpanKind.CLIENT);

    this._setLanggraphAttributes(span, metadata);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_PROVIDER_NAME, provider);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_OPERATION_NAME, GEN_AI_OPERATION_NAME_VALUE_CHAT);
    this._setModelRequestAttributes(span, extraParams, config, modelName);

    if (this.captureMessageContent && messages.length > 0) {
      const { systemInstructions, conversation } = OpenTelemetryCallbackHandler._formatMessages(messages);
      if (conversation.length > 0) {
        OpenTelemetryCallbackHandler._setAttribute(
          span,
          ATTR_GEN_AI_INPUT_MESSAGES,
          OpenTelemetryCallbackHandler._serializeToJson(conversation)
        );
      }
      if (systemInstructions.length > 0) {
        OpenTelemetryCallbackHandler._setAttribute(
          span,
          ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
          OpenTelemetryCallbackHandler._serializeToJson(systemInstructions)
        );
      }
    }

    this._propagateToAgentSpan(runId, provider, modelName, extraParams, config);
  }

  override handleLLMStart(
    serialized: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>
  ): void {
    const config = OpenTelemetryCallbackHandler._getSerializedConfig(serialized) ?? {};
    const modelName = OpenTelemetryCallbackHandler._extractModelId(extraParams, config, metadata, serialized);
    const provider = OpenTelemetryCallbackHandler._extractModelProvider(serialized, extraParams, metadata);
    const spanName = modelName
      ? `${GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION} ${modelName}`
      : GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION;

    const span = this._startSpan(runId, parentRunId, spanName, SpanKind.CLIENT);

    this._setLanggraphAttributes(span, metadata);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_PROVIDER_NAME, provider);
    OpenTelemetryCallbackHandler._setAttribute(
      span,
      ATTR_GEN_AI_OPERATION_NAME,
      GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION
    );
    this._setModelRequestAttributes(span, extraParams, config, modelName);

    if (this.captureMessageContent && prompts.length > 0) {
      const conversation = prompts.map(prompt => ({ role: 'user', parts: [{ type: 'text', content: prompt }] }));
      OpenTelemetryCallbackHandler._setAttribute(
        span,
        ATTR_GEN_AI_INPUT_MESSAGES,
        OpenTelemetryCallbackHandler._serializeToJson(conversation)
      );
    }

    this._propagateToAgentSpan(runId, provider, modelName, extraParams, config);
  }

  override handleLLMEnd(response: LLMResult, runId: string, parentRunId?: string): void {
    const entry = this.runIdToSpanMap.get(runId);
    if (!entry?.span) return;
    const { span } = entry;

    const llmOutput = response.llmOutput ?? {};
    const usage = llmOutput.token_usage ?? llmOutput.usage ?? {};
    const model = llmOutput.model_name ?? llmOutput.model_id;
    let responseId = llmOutput.id;
    let inputTokens = usage.prompt_tokens ?? usage.input_token_count ?? usage.input_tokens;
    let outputTokens = usage.completion_tokens ?? usage.generated_token_count ?? usage.output_tokens;

    const firstGeneration = response.generations?.[0]?.[0];
    const message =
      firstGeneration && 'message' in firstGeneration ? (firstGeneration as ChatGeneration).message : undefined;
    if (message && isAIMessage(message)) {
      const usageMeta = message.usage_metadata;
      inputTokens = usageMeta?.input_tokens ?? inputTokens;
      outputTokens = usageMeta?.output_tokens ?? outputTokens;
      responseId = message.id ?? responseId;
    }

    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_USAGE_INPUT_TOKENS, inputTokens);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, outputTokens);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_RESPONSE_ID, responseId);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_RESPONSE_MODEL, model);

    if (response.generations?.length > 0) {
      if (this.captureMessageContent) {
        const outputMessages = OpenTelemetryCallbackHandler._formatOutputMessages(response);
        if (outputMessages.length > 0) {
          OpenTelemetryCallbackHandler._setAttribute(
            span,
            ATTR_GEN_AI_OUTPUT_MESSAGES,
            OpenTelemetryCallbackHandler._serializeToJson(outputMessages)
          );
        }
      }

      const finishReasons = OpenTelemetryCallbackHandler._extractFinishReasons(response);
      if (finishReasons.length > 0) {
        OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_RESPONSE_FINISH_REASONS, finishReasons);
      }
    }

    this._endSpan(runId, parentRunId);
  }

  override handleLLMError(err: Error, runId: string, parentRunId?: string): void {
    this._handleError(err, runId, parentRunId);
  }

  override handleChainStart(
    serialized: Serialized,
    _inputs: ChainValues,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string
  ): void {
    const name = OpenTelemetryCallbackHandler._extractLCName(serialized, undefined, runName);
    if (this._shouldSkipChain(serialized, name, metadata)) {
      const parentEntry = parentRunId ? this.runIdToSpanMap.get(parentRunId) : undefined;
      if (parentEntry) {
        this.runIdToSpanMap.set(runId, { context: parentEntry.context, agentSpan: parentEntry.agentSpan });
      }
      return;
    }

    const isAgentChain =
      !!name && (name.includes('AgentExecutor') || name === 'LangGraph' || name === metadata?.lc_agent_name);
    const provider = OpenTelemetryCallbackHandler._extractModelProvider(serialized);
    const lcAgentName = metadata?.lc_agent_name;
    const agentName = (typeof lcAgentName === 'string' ? lcAgentName : undefined) || (isAgentChain ? name : undefined);
    const operation = isAgentChain ? GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT : 'chain';
    const spanName = name ? `${operation} ${name}` : operation;

    const span = this._startSpan(runId, parentRunId, spanName);

    // Track nearest invoke_agent ancestor for attribute propagation
    const entry = this.runIdToSpanMap.get(runId);
    if (entry && isAgentChain) {
      entry.agentSpan = span;
    }

    this._setLanggraphAttributes(span, metadata);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_PROVIDER_NAME, provider);
    if (isAgentChain) {
      OpenTelemetryCallbackHandler._setAttribute(
        span,
        ATTR_GEN_AI_OPERATION_NAME,
        GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT
      );
    }
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_AGENT_NAME, agentName);
  }

  override handleChainEnd(_outputs: ChainValues, runId: string, parentRunId?: string): void {
    this._endSpan(runId, parentRunId);
  }

  override handleChainError(err: Error, runId: string, parentRunId?: string): void {
    this._handleError(err, runId, parentRunId);
  }

  override handleToolStart(
    serialized: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string
  ): void {
    const name = runName || OpenTelemetryCallbackHandler._extractLCName(serialized);
    const provider = OpenTelemetryCallbackHandler._extractModelProvider(serialized);
    const spanName = name
      ? `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${name}`
      : GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL;

    const span = this._startSpan(runId, parentRunId, spanName);

    this._setLanggraphAttributes(span, metadata);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_PROVIDER_NAME, provider);
    OpenTelemetryCallbackHandler._setAttribute(
      span,
      ATTR_GEN_AI_OPERATION_NAME,
      GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL
    );
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_TOOL_NAME, name);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_TOOL_TYPE, 'function');
    OpenTelemetryCallbackHandler._setAttribute(
      span,
      ATTR_GEN_AI_TOOL_DESCRIPTION,
      'kwargs' in serialized ? serialized.kwargs?.description : undefined
    );
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_TOOL_CALL_ID, toolCallId);
    if (this.captureMessageContent) {
      OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_TOOL_CALL_ARGUMENTS, input);
    }
  }

  override handleToolEnd(output: unknown, runId: string, parentRunId?: string): void {
    if (this.captureMessageContent) {
      const entry = this.runIdToSpanMap.get(runId);
      if (entry?.span) {
        const content = output && typeof output === 'object' && 'content' in output ? output.content : output;
        const outputStr =
          typeof content === 'string' ? content : OpenTelemetryCallbackHandler._serializeToJson(content);
        OpenTelemetryCallbackHandler._setAttribute(entry.span, ATTR_GEN_AI_TOOL_CALL_RESULT, outputStr);
      }
    }
    this._endSpan(runId, parentRunId);
  }

  override handleToolError(err: Error, runId: string, parentRunId?: string): void {
    this._handleError(err, runId, parentRunId);
  }

  private _handleError(error: Error | unknown, runId: string, parentRunId?: string): void {
    const entry = this.runIdToSpanMap.get(runId);
    if (!entry?.span) return;
    const { span } = entry;
    if (span.isRecording()) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      OpenTelemetryCallbackHandler._setAttribute(span, ATTR_ERROR_TYPE, err.constructor.name);
    }
    this._endSpan(runId, parentRunId);
  }

  private _startSpan(
    runId: string,
    parentRunId: string | undefined,
    spanName: string,
    kind: SpanKind = SpanKind.INTERNAL
  ): Span {
    const parentEntry = parentRunId ? this.runIdToSpanMap.get(parentRunId) : undefined;
    const parentCtx = parentEntry ? parentEntry.context : context.active();
    const span = this.tracer.startSpan(spanName, { kind }, parentCtx);
    const spanContext = trace.setSpan(parentCtx, span);
    this.runIdToSpanMap.set(runId, { span, context: spanContext, agentSpan: parentEntry?.agentSpan });
    OpenTelemetryCallbackHandler._attachContext(spanContext);
    return span;
  }

  private _endSpan(runId: string, parentRunId?: string): void {
    const entry = this.runIdToSpanMap.get(runId);
    if (!entry) return;
    this.runIdToSpanMap.delete(runId);
    entry.span?.end();
    this._detachContext(parentRunId);
  }

  private _detachContext(parentRunId?: string): void {
    const parentEntry = parentRunId ? this.runIdToSpanMap.get(parentRunId) : undefined;
    OpenTelemetryCallbackHandler._attachContext(parentEntry ? parentEntry.context : context.active());
  }

  private static _attachContext(ctx: OtelContext): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contextManager = (context as any)['_getContextManager']?.();
    contextManager?._asyncLocalStorage?.enterWith(ctx);
  }

  private _shouldSkipChain(
    serialized: Serialized,
    name: string | undefined,
    metadata?: Record<string, unknown>
  ): boolean {
    if (!this.shouldSuppressInternalChains) return false;

    const isAgentNode =
      (!!name && (name === 'LangGraph' || name.includes('AgentExecutor'))) ||
      (!!metadata && 'lc_agent_name' in metadata);

    if (isAgentNode) return false;

    const idPath = serialized.id?.join('.') ?? '';
    if (idPath.includes('runnables') || idPath.includes('prompts') || idPath.includes('output_parsers')) {
      return true;
    }

    if (name && (name.startsWith('Runnable') || name.endsWith('OutputParser') || name.endsWith('PromptTemplate'))) {
      return true;
    }

    if (metadata && Object.keys(metadata).some(k => k.startsWith('langgraph_'))) {
      return true;
    }

    return false;
  }

  private _setModelRequestAttributes(
    span: Span,
    extraParams?: Record<string, unknown>,
    config?: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    modelName?: string
  ): void {
    const resolvedConfig = config ?? {};
    const model = OpenTelemetryCallbackHandler._extractModelId(extraParams, resolvedConfig) || modelName;
    if (model) {
      OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_REQUEST_MODEL, model);
    }

    const invocationParams = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    const params = (invocationParams.params ?? invocationParams) as Record<string, unknown>;
    OpenTelemetryCallbackHandler._setAttribute(
      span,
      ATTR_GEN_AI_REQUEST_MAX_TOKENS,
      params.max_tokens ?? params.max_new_tokens ?? resolvedConfig.max_tokens
    );
    OpenTelemetryCallbackHandler._setAttribute(
      span,
      ATTR_GEN_AI_REQUEST_TEMPERATURE,
      params.temperature ?? resolvedConfig.temperature
    );
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_REQUEST_TOP_P, params.top_p ?? resolvedConfig.top_p);
    OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_REQUEST_TOP_K, params.top_k ?? resolvedConfig.top_k);
    OpenTelemetryCallbackHandler._setAttribute(
      span,
      ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
      params.frequency_penalty ?? resolvedConfig.frequency_penalty
    );
    OpenTelemetryCallbackHandler._setAttribute(
      span,
      ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
      params.presence_penalty ?? resolvedConfig.presence_penalty
    );
    const stop = params.stop ?? resolvedConfig.stop;
    if (stop) {
      OpenTelemetryCallbackHandler._setAttribute(span, ATTR_GEN_AI_REQUEST_STOP_SEQUENCES, stop);
    }
  }

  private _propagateToAgentSpan(
    runId: string,
    provider?: string,
    modelName?: string,
    extraParams?: Record<string, unknown>,
    config?: Record<string, unknown>
  ): void {
    const entry = this.runIdToSpanMap.get(runId);
    if (!entry?.agentSpan?.isRecording()) return;
    const agentSpan = entry.agentSpan;
    OpenTelemetryCallbackHandler._setAttribute(agentSpan, ATTR_GEN_AI_PROVIDER_NAME, provider);
    OpenTelemetryCallbackHandler._setAttribute(agentSpan, ATTR_GEN_AI_REQUEST_MODEL, modelName);
    const invocationParams = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    const params = (invocationParams.params ?? invocationParams) as Record<string, unknown>;
    const temperature = params.temperature ?? (config as Record<string, unknown> | undefined)?.temperature;
    OpenTelemetryCallbackHandler._setAttribute(agentSpan, ATTR_GEN_AI_REQUEST_TEMPERATURE, temperature);
  }

  private _setLanggraphAttributes(span: Span, metadata?: Record<string, unknown>): void {
    if (!metadata) return;
    OpenTelemetryCallbackHandler._setAttribute(span, LANGGRAPH_STEP_SPAN_ATTR, metadata.langgraph_step);
    OpenTelemetryCallbackHandler._setAttribute(span, LANGGRAPH_NODE_SPAN_ATTR, metadata.langgraph_node);
  }

  private static _extractLCName(
    serialized: Serialized,
    extraParams?: Record<string, unknown>,
    runName?: string
  ): string | undefined {
    if (runName) return runName;
    const config = OpenTelemetryCallbackHandler._getSerializedConfig(serialized);
    if (config?.name) return config.name;
    if (serialized.name) return serialized.name;
    if (serialized.id?.length) return serialized.id[serialized.id.length - 1];
    return extraParams?.name as string | undefined;
  }

  private static _extractModelId(
    extraParams?: Record<string, unknown>,
    config?: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    metadata?: Record<string, unknown>,
    serialized?: Serialized
  ): string | undefined {
    if (typeof metadata?.ls_model_name === 'string') return metadata.ls_model_name;
    const invocationParams = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    const sources = [extraParams, invocationParams, config];
    for (const source of sources) {
      if (!source) continue;
      const model = source.model ?? source.model_name ?? source.model_id ?? source.base_model_id;
      if (typeof model === 'string' && model) return model;
    }
    if (serialized) return OpenTelemetryCallbackHandler._extractLCName(serialized, extraParams);
    return undefined;
  }

  private static _extractModelProvider(
    serialized: Serialized,
    extraParams?: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): string | undefined {
    if (typeof metadata?.ls_provider === 'string') {
      const provider = PROVIDER_MAP[metadata.ls_provider.toLowerCase()];
      if (provider) return provider;
    }
    if (serialized.id) {
      for (const part of serialized.id) {
        const provider = PROVIDER_MAP[part.toLowerCase()];
        if (provider) return provider;
      }
    }

    const invocationParams = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    const invType = invocationParams._type;
    if (typeof invType === 'string' && invType) {
      const prefix = invType.split('-')[0].toLowerCase();
      const provider = PROVIDER_MAP[prefix];
      if (provider) return provider;
    }

    const modelId = invocationParams.model_id ?? extraParams?.model_id;
    if (typeof modelId === 'string' && modelId.includes('/')) {
      const prefix = modelId.split('/')[0].toLowerCase();
      const provider = PROVIDER_MAP[prefix];
      if (provider) return provider;
    }

    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static _getSerializedConfig(serialized: Serialized): Record<string, any> | undefined {
    return 'kwargs' in serialized ? serialized.kwargs : undefined;
  }

  private static _formatMessages(messages: BaseMessage[][]): {
    systemInstructions: Array<{ type: string; content: string }>;
    conversation: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  } {
    const systemInstructions: Array<{ type: string; content: string }> = [];
    const conversation: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

    for (const messageGroup of messages) {
      for (const message of messageGroup) {
        const messageType = message.getType();
        const role = OpenTelemetryCallbackHandler._normalizeRole(messageType);
        const parts: Array<Record<string, unknown>> = [];

        const textContent =
          typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
            ? message.content
                .filter(
                  (block): block is { type: 'text'; text: string } =>
                    typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
                )
                .map(block => block.text)
                .join('')
            : '';

        if (textContent) {
          parts.push({ type: 'text', content: textContent });
        }

        if (isAIMessage(message) && message.tool_calls) {
          for (const toolCall of message.tool_calls as ToolCall[]) {
            parts.push({
              type: 'tool_call',
              id: toolCall.id ?? '',
              name: toolCall.name,
              arguments: toolCall.args,
            });
          }
        }

        if (role === 'tool' && 'tool_call_id' in message && message.tool_call_id) {
          parts.push({
            type: 'tool_call_response',
            id: message.tool_call_id,
            response: textContent,
          });
        }

        if (role === 'system') {
          systemInstructions.push({ type: 'text', content: textContent });
        } else if (parts.length > 0) {
          conversation.push({ role, parts });
        }
      }
    }

    return { systemInstructions, conversation };
  }

  private static _formatOutputMessages(
    response: LLMResult
  ): Array<{ role: string; parts: Array<Record<string, unknown>>; finish_reason: string }> {
    const outputMessages: Array<{ role: string; parts: Array<Record<string, unknown>>; finish_reason: string }> = [];

    for (const generationGroup of response.generations) {
      for (const generation of generationGroup) {
        const parts: Array<Record<string, unknown>> = [];
        let finishReason: string | undefined;

        if ('message' in generation) {
          const message = (generation as ChatGeneration).message;

          const textContent =
            typeof message.content === 'string'
              ? message.content
              : Array.isArray(message.content)
              ? message.content
                  .filter(
                    (block): block is { type: 'text'; text: string } =>
                      typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
                  )
                  .map(block => block.text)
                  .join('')
              : '';

          if (textContent) {
            parts.push({ type: 'text', content: textContent });
          }

          if (isAIMessage(message) && message.tool_calls) {
            for (const toolCall of message.tool_calls as ToolCall[]) {
              parts.push({
                type: 'tool_call',
                id: toolCall.id ?? '',
                name: toolCall.name,
                arguments: toolCall.args,
              });
            }
          }

          const rawReason =
            generation.generationInfo?.finish_reason ??
            message.response_metadata?.finish_reason ??
            message.response_metadata?.stop_reason ??
            message.response_metadata?.stopReason ??
            message.response_metadata?.finishReason;
          if (typeof rawReason === 'string') {
            finishReason = OpenTelemetryCallbackHandler._normalizeFinishReason(rawReason);
          }
        } else {
          if (generation.text) {
            parts.push({ type: 'text', content: generation.text });
          }
        }

        if (parts.length > 0) {
          outputMessages.push({
            role: 'assistant',
            parts,
            finish_reason: finishReason ?? 'stop',
          });
        }
      }
    }

    return outputMessages;
  }

  private static _extractFinishReasons(response: LLMResult): string[] {
    const reasons: string[] = [];
    for (const generationGroup of response.generations) {
      for (const generation of generationGroup) {
        if ('message' in generation) {
          const message = (generation as ChatGeneration).message;
          const rawReason =
            generation.generationInfo?.finish_reason ??
            message.response_metadata?.finish_reason ??
            message.response_metadata?.stop_reason ??
            message.response_metadata?.stopReason ??
            message.response_metadata?.finishReason;
          if (typeof rawReason === 'string') {
            reasons.push(OpenTelemetryCallbackHandler._normalizeFinishReason(rawReason));
          }
        }
      }
    }
    return reasons;
  }

  private static _normalizeRole(messageType: string): string {
    switch (messageType) {
      case 'human':
      case 'generic':
        return 'user';
      case 'ai':
        return 'assistant';
      case 'system':
        return 'system';
      case 'tool':
      case 'function':
        return 'tool';
      default:
        return messageType;
    }
  }

  private static _normalizeFinishReason(raw: string): string {
    switch (raw) {
      case 'stop':
      case 'end_turn':
      case 'STOP':
      case 'COMPLETE':
        return 'stop';
      case 'length':
      case 'max_tokens':
      case 'MAX_TOKENS':
      case 'ERROR_LIMIT':
        return 'length';
      case 'content_filter':
      case 'SAFETY':
      case 'RECITATION':
      case 'ERROR_TOXIC':
        return 'content_filter';
      case 'tool_use':
      case 'tool_calls':
      case 'function_call':
        return 'tool_call';
      case 'error':
      case 'ERROR':
        return 'error';
      default:
        return raw;
    }
  }

  private static _serializeToJson(value: unknown, maxDepth: number = 10): string {
    const sanitize = (obj: unknown, depth: number): unknown => {
      if (depth <= 0) return '...';
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return obj;
      if (Array.isArray(obj)) return obj.map(item => sanitize(item, depth - 1));
      if (typeof obj === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(obj)) {
          result[key] = sanitize(val, depth - 1);
        }
        return result;
      }
      return String(obj);
    };

    try {
      return JSON.stringify(sanitize(value, maxDepth));
    } catch {
      return String(value);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static _setAttribute(span: Span, name: string, value: any): void {
    if (span.isRecording() && value !== undefined && value !== null && value !== '') {
      span.setAttribute(name, value);
    }
  }
}
