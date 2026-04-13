// SPDX-License-Identifier: Apache-2.0

/**
 * OTel callback handler for LangChain instrumentation.
 *
 * This module provides a BaseCallbackHandler subclass that creates and manages
 * OpenTelemetry spans for LangChain operations including LLM calls, chains, and tools.
 * It follows OTel Gen AI semantic conventions v1.39.
 */

import { context, trace, Tracer, Span, SpanKind, SpanStatusCode, Context as OtelContext } from '@opentelemetry/api';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_METADATA,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_OUTPUT_TOOL_CALLS,
} from './semconv';

/** Entry stored in the run map for tracking spans and their contexts. */
interface RunEntry {
  span: Span;
  context: OtelContext;
}

/** Shared run map across all handler instances to maintain parent-child relationships. */
const sharedRunMap: Map<string, RunEntry> = new Map();

/**
 * Stack-based context tracking for LangGraph streaming.
 * Since LangGraph doesn't pass parentRunId, we track the execution stack manually.
 */
const spanStack: RunEntry[] = [];

/**
 * OpenTelemetry callback handler for LangChain.
 *
 * Creates and manages OTel spans for LangChain operations (LLM calls, chains, tools).
 * Uses a combination of runId mapping and stack-based tracking for parent-child relationships.
 */
export class OTelCallbackHandler extends BaseCallbackHandler {
  /** Handler name used by LangChain for deduplication. */
  name = 'OTelCallbackHandler';

  /** Ensures spans are ended before next operation. */
  override awaitHandlers = true;

  private tracer: Tracer;

  /**
   * Creates a new OTelCallbackHandler.
   * @param tracer - The OTel tracer to use for creating spans.
   */
  constructor(tracer: Tracer) {
    super();
    this.tracer = tracer;
  }

  /**
   * Extracts the gen_ai.system provider from LLM metadata.
   * @param llm - Serialized LLM object containing provider info.
   * @returns Provider string (e.g., 'aws.bedrock', 'openai', 'anthropic', or last element of id array).
   */
  private extractProvider(llm: { id?: string[] }): string {
    const idStr = JSON.stringify(llm.id || []).toLowerCase();
    if (idStr.includes('bedrock')) return 'aws.bedrock';
    if (idStr.includes('openai')) return 'openai';
    if (idStr.includes('anthropic')) return 'anthropic';
    // Return last element of id array (e.g., ['langchain', 'llms', 'custom'] -> 'custom')
    return llm.id?.[llm.id.length - 1] || 'unknown';
  }

  /**
   * Gets the parent context using multiple strategies:
   * 1. parentRunId from callback (when available)
   * 2. Stack-based tracking (for LangGraph streaming)
   * 3. Active OTEL context (fallback)
   */
  private getParentContext(parentRunId?: string): OtelContext {
    // Strategy 1: Use parentRunId if provided and found
    if (parentRunId) {
      const parent = sharedRunMap.get(parentRunId);
      if (parent) {
        return parent.context;
      }
    }
    
    // Strategy 2: Use stack-based tracking (top of stack is current parent)
    if (spanStack.length > 0) {
      return spanStack[spanStack.length - 1].context;
    }
    
    // Strategy 3: Fallback to active OTEL context
    return context.active();
  }

  /**
   * Extracts metadata as a JSON string (matching Python instrumentation format).
   * @param metadata - Callback metadata that may contain LangGraph info.
   * @returns Object with metadata attribute as JSON string if present.
   */
  private extractMetadataAttribute(metadata?: Record<string, unknown>): Record<string, string> {
    if (!metadata) return {};
    
    // Extract relevant metadata fields for the metadata attribute
    const metadataObj: Record<string, unknown> = {};
    const relevantKeys = ['langgraph_step', 'langgraph_node', 'langgraph_triggers', 'langgraph_path', 'langgraph_checkpoint_ns', 'checkpoint_ns'];
    
    for (const key of relevantKeys) {
      if (metadata[key] !== undefined) {
        metadataObj[key] = metadata[key];
      }
    }
    
    if (Object.keys(metadataObj).length === 0) return {};
    return { [ATTR_METADATA]: JSON.stringify(metadataObj) };
  }

  /**
   * Normalizes LangChain messages to OTel semantic convention format.
   * Converts from LangChain's lc-serialized format to: { role, parts: [{ type, content }] }
   */
  private normalizeInputMessages(messages: unknown[][]): Array<{ role: string; parts: Array<{ type: string; content: string }> }> {
    const result: Array<{ role: string; parts: Array<{ type: string; content: string }> }> = [];
    // Flatten nested arrays (LangChain passes [[msg1, msg2, ...]])
    const flatMessages = messages.flat();
    
    for (const msg of flatMessages) {
      const m = msg as { type?: string; kwargs?: { content?: unknown }; id?: string[] };
      let role = 'user';
      let content = '';
      
      // LangChain lc-serialized format: { lc, type, id: [..., "HumanMessage"], kwargs: { content } }
      if (m.id && Array.isArray(m.id)) {
        const msgType = m.id[m.id.length - 1];
        if (msgType === 'HumanMessage') role = 'user';
        else if (msgType === 'AIMessage' || msgType === 'AIMessageChunk') role = 'assistant';
        else if (msgType === 'SystemMessage') role = 'system';
        else if (msgType === 'ToolMessage') role = 'tool';
        content = this.extractTextContent(m.kwargs?.content);
      } else if (typeof m.type === 'string') {
        // Direct format: { type: "human", content: "..." }
        role = m.type === 'human' ? 'user' : m.type === 'ai' ? 'assistant' : m.type;
        content = this.extractTextContent((m as { content?: unknown }).content);
      }
      
      if (content) {
        result.push({ role, parts: [{ type: 'text', content }] });
      }
    }
    return result;
  }

  /**
   * Extracts text content from various content formats.
   */
  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      // Content blocks: [{ type: "text", text: "..." }]
      const textParts = content
        .filter((c): c is { type: string; text?: string } => c?.type === 'text')
        .map(c => c.text)
        .filter(Boolean);
      return textParts.join('\n');
    }
    return '';
  }

  /**
   * Normalizes output content to OTel semantic convention format.
   */
  private normalizeOutputMessages(content: unknown): Array<{ role: string; parts: Array<{ type: string; content: string }> }> {
    const text = this.extractTextContent(content);
    if (!text) return [];
    return [{ role: 'assistant', parts: [{ type: 'text', content: text }] }];
  }

  /**
   * Starts a span and stores it in the run map and stack.
   */
  private startSpan(
    name: string,
    kind: SpanKind,
    runId: string,
    parentRunId?: string,
    attributes?: Record<string, string | number>,
    metadata?: Record<string, unknown>
  ): void {
    const parentCtx = this.getParentContext(parentRunId);
    const span = this.tracer.startSpan(name, { kind }, parentCtx);
    
    // Set base attributes
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
    }
    
    // Extract and set metadata attribute (JSON string)
    const metadataAttr = this.extractMetadataAttribute(metadata);
    for (const [key, value] of Object.entries(metadataAttr)) {
      span.setAttribute(key, value);
    }
    
    const entry: RunEntry = { span, context: trace.setSpan(parentCtx, span) };
    sharedRunMap.set(runId, entry);
    spanStack.push(entry);
  }

  /**
   * Ends a span and removes it from tracking.
   */
  private endSpan(runId: string): void {
    const entry = sharedRunMap.get(runId);
    if (entry) {
      entry.span.end();
      sharedRunMap.delete(runId);
      // Remove from stack (should be at top, but search to be safe)
      const idx = spanStack.indexOf(entry);
      if (idx !== -1) spanStack.splice(idx, 1);
    }
  }

  /**
   * Records an error on a span and ends it.
   */
  private endSpanWithError(runId: string, error: Error): void {
    const entry = sharedRunMap.get(runId);
    if (entry) {
      entry.span.recordException(error);
      entry.span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      entry.span.end();
      sharedRunMap.delete(runId);
      const idx = spanStack.indexOf(entry);
      if (idx !== -1) spanStack.splice(idx, 1);
    }
  }

  /**
   * Called at the start of a Chat Model run.
   */
  override handleChatModelStart(
    llm: { id?: string[]; kwargs?: { model?: string; model_id?: string } },
    messages: unknown[][],
    runId: string,
    parentRunId?: string,
    extraParams?: { invocation_params?: Record<string, unknown>; options?: Record<string, unknown>; ls_model_name?: string },
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): void {
    // Model extraction priority: extraParams.ls_model_name > invocation_params > options > llm.kwargs > metadata
    const invParams = extraParams?.invocation_params as Record<string, string> | undefined;
    const opts = extraParams?.options as Record<string, string> | undefined;
    const model = extraParams?.ls_model_name
      || invParams?.model || invParams?.model_id || invParams?.modelId
      || opts?.model || opts?.model_id || opts?.modelId
      || llm.kwargs?.model || llm.kwargs?.model_id
      || (metadata?.ls_model_name as string) || (metadata?.model as string)
      || 'unknown';
    const provider = this.extractProvider(llm);
    
    const attrs: Record<string, string | number> = {
      [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
      [ATTR_GEN_AI_REQUEST_MODEL]: model,
      [ATTR_GEN_AI_SYSTEM]: provider,
    };
    
    // Add input messages (normalized to OTel format)
    if (messages && messages.length > 0) {
      try {
        attrs[ATTR_GEN_AI_INPUT_MESSAGES] = JSON.stringify(this.normalizeInputMessages(messages));
      } catch { /* ignore serialization errors */ }
    }
    
    this.startSpan(`chat ${model}`, SpanKind.CLIENT, runId, parentRunId, attrs, metadata);
  }

  /**
   * Called at the start of an LLM run (fallback when handleChatModelStart not called).
   */
  override handleLLMStart(
    llm: { id?: string[]; kwargs?: { model?: string; model_id?: string } },
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: { model?: string; invocation_params?: { model?: string; model_id?: string } },
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): void {
    const model = extraParams?.model 
      || extraParams?.invocation_params?.model 
      || extraParams?.invocation_params?.model_id
      || llm.kwargs?.model 
      || llm.kwargs?.model_id 
      || 'unknown';
    const provider = this.extractProvider(llm);
    
    const attrs: Record<string, string | number> = {
      [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
      [ATTR_GEN_AI_REQUEST_MODEL]: model,
      [ATTR_GEN_AI_SYSTEM]: provider,
    };
    
    // Add prompts as input (normalized to OTel format)
    if (prompts && prompts.length > 0) {
      try {
        attrs[ATTR_GEN_AI_INPUT_MESSAGES] = JSON.stringify(
          prompts.map(p => ({ role: 'user', parts: [{ type: 'text', content: p }] }))
        );
      } catch { /* ignore */ }
    }
    
    this.startSpan(`chat ${model}`, SpanKind.CLIENT, runId, parentRunId, attrs, metadata);
  }

  /**
   * Called at the end of an LLM/ChatModel run.
   */
  override handleLLMEnd(
    output: { 
      llmOutput?: Record<string, unknown>;
      generations?: Array<Array<{ text?: string; message?: Record<string, unknown> }>>;
    },
    runId: string
  ): void {
    const entry = sharedRunMap.get(runId);
    if (entry) {
      const gen = output.generations?.[0]?.[0];
      if (gen) {
        // Extract kwargs - handle both direct and serialized format
        const msg = gen.message;
        const kwargs = (msg?.kwargs || msg) as Record<string, unknown> | undefined;
        
        // Output content (normalized to OTel format)
        const content = gen.text || kwargs?.content;
        if (content) {
          entry.span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify(this.normalizeOutputMessages(content)));
        }
        
        if (kwargs) {
          // Token usage from usage_metadata
          const usage = kwargs.usage_metadata as { input_tokens?: number; output_tokens?: number } | undefined;
          if (usage?.input_tokens !== undefined) {
            entry.span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.input_tokens);
          }
          if (usage?.output_tokens !== undefined) {
            entry.span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.output_tokens);
          }
          
          // Response metadata (model, stop reason)
          const respMeta = kwargs.response_metadata as Record<string, unknown> | undefined;
          if (respMeta?.stopReason) {
            entry.span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, JSON.stringify([respMeta.stopReason]));
          }
          
          // Response ID
          if (kwargs.id) {
            entry.span.setAttribute(ATTR_GEN_AI_RESPONSE_ID, String(kwargs.id));
          }
          
          // Tool calls - output as structured data
          const toolCalls = kwargs.tool_calls as Array<{ name?: string; id?: string; args?: unknown }> | undefined;
          if (toolCalls?.length) {
            entry.span.setAttribute(ATTR_GEN_AI_OUTPUT_TOOL_CALLS, JSON.stringify(toolCalls));
          }
        }
      }
    }
    this.endSpan(runId);
  }

  /**
   * Called if an LLM/ChatModel run encounters an error.
   */
  override handleLLMError(err: Error, runId: string): void {
    this.endSpanWithError(runId, err);
  }

  /**
   * Called at the start of a Chain run.
   */
  override handleChainStart(
    chain: { name?: string },
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string
  ): void {
    const name = runName || chain.name || 'unknown';
    this.startSpan(`chain ${name}`, SpanKind.INTERNAL, runId, parentRunId, {
      [ATTR_GEN_AI_OPERATION_NAME]: 'chain',
    }, metadata);
  }

  /**
   * Called at the end of a Chain run.
   */
  override handleChainEnd(outputs: Record<string, unknown>, runId: string): void {
    this.endSpan(runId);
  }

  /**
   * Called if a Chain run encounters an error.
   */
  override handleChainError(err: Error, runId: string): void {
    this.endSpanWithError(runId, err);
  }

  /**
   * Called at the start of a Tool run.
   */
  override handleToolStart(
    tool: { name?: string },
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): void {
    const name = runName || tool.name || 'unknown';
    this.startSpan(`execute_tool ${name}`, SpanKind.INTERNAL, runId, parentRunId, {
      [ATTR_GEN_AI_OPERATION_NAME]: 'execute_tool',
      [ATTR_GEN_AI_TOOL_NAME]: name,
    }, metadata);
  }

  /**
   * Called at the end of a Tool run.
   */
  override handleToolEnd(output: string, runId: string): void {
    this.endSpan(runId);
  }

  /**
   * Called if a Tool run encounters an error.
   */
  override handleToolError(err: Error, runId: string): void {
    this.endSpanWithError(runId, err);
  }
}
