// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import {
  diag,
  DiagConsoleLogger,
  Attributes,
  AttributeValue,
  TimeInput,
  ROOT_CONTEXT,
  SpanContext,
  HrTime,
} from '@opentelemetry/api';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { EventLoggerProvider } from '@opentelemetry/sdk-events';
import { EventLogger, Event } from '@opentelemetry/api-events';
import { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { AnyValue } from '@opentelemetry/api-logs';
import { Mutable } from './utils';

// Message event types
const GEN_AI_SYSTEM_MESSAGE = 'gen_ai.system.message';
const GEN_AI_USER_MESSAGE = 'gen_ai.user.message';
const GEN_AI_ASSISTANT_MESSAGE = 'gen_ai.assistant.message';

// Framework-specific attribute keys
const TRACELOOP_ENTITY_INPUT = 'traceloop.entity.input';
const TRACELOOP_ENTITY_OUTPUT = 'traceloop.entity.output';
const TRACELOOP_CREW_TASKS_OUTPUT = 'crewai.crew.tasks_output';
const TRACELOOP_CREW_RESULT = 'crewai.crew.result';
const OPENINFERENCE_INPUT_VALUE = 'input.value';
const OPENINFERENCE_OUTPUT_VALUE = 'output.value';
const OPENLIT_PROMPT = 'gen_ai.prompt';
const OPENLIT_COMPLETION = 'gen_ai.completion';
const OPENLIT_REVISED_PROMPT = 'gen_ai.content.revised_prompt';
const OPENLIT_AGENT_ACTUAL_OUTPUT = 'gen_ai.agent.actual_output';
const OPENLIT_AGENT_HUMAN_INPUT = 'gen_ai.agent.human_input';

// Patterns for attribute filtering - using a set for O(1) lookups
const exactMatchPatterns = new Set([
  TRACELOOP_ENTITY_INPUT,
  TRACELOOP_ENTITY_OUTPUT,
  TRACELOOP_CREW_TASKS_OUTPUT,
  TRACELOOP_CREW_RESULT,
  OPENLIT_PROMPT,
  OPENLIT_COMPLETION,
  OPENLIT_REVISED_PROMPT,
  OPENLIT_AGENT_ACTUAL_OUTPUT,
  OPENLIT_AGENT_HUMAN_INPUT,
  OPENINFERENCE_INPUT_VALUE,
  OPENINFERENCE_OUTPUT_VALUE,
]);

// Roles
const ROLE_SYSTEM = 'system';
const ROLE_USER = 'user';
const ROLE_ASSISTANT = 'assistant';

// Patterns used in extraction methods
const promptContentPattern = new RegExp('^gen_ai\\.prompt\\.(\\d+)\\.content$');
const completionContentPattern = new RegExp('^gen_ai\\.completion\\.(\\d+)\\.content$');
const openinferenceInputMsgPattern = new RegExp('^llm\\.input_messages\\.(\\d+)\\.message\\.content$');
const openinferenceOutputMsgPattern = new RegExp('^llm\\.output_messages\\.(\\d+)\\.message\\.content$');

const regexPatterns = [
  promptContentPattern,
  completionContentPattern,
  openinferenceInputMsgPattern,
  openinferenceOutputMsgPattern,
];

interface PromptContent {
  key: string;
  value: AttributeValue | undefined;
  role: AttributeValue;
}

diag.setLogger(new DiagConsoleLogger(), opentelemetry.core.getEnv().OTEL_LOG_LEVEL);

/**
 * Utility class for handling Large Language Objects (LLO) in OpenTelemetry spans.
 *
 * LLOHandler performs three primary functions:
 * 1. Identifies Large Language Objects (LLO) content in spans
 * 2. Extracts and transforms these attributes into OpenTelemetry Gen AI Events
 * 3. Filters LLO from spans to maintain privacy and reduce span size
 *
 * Supported frameworks and their attribute patterns:
 * - Standard Gen AI:
 *   - gen_ai.prompt.{n}.content: Structured prompt content
 *   - gen_ai.prompt.{n}.role: Role for prompt content (system, user, assistant, etc.)
 *   - gen_ai.completion.{n}.content: Structured completion content
 *   - gen_ai.completion.{n}.role: Role for completion content (usually assistant)
 *
 * - Traceloop:
 *   - traceloop.entity.input: Input text for LLM operations
 *   - traceloop.entity.output: Output text from LLM operations
 *   - traceloop.entity.name: Name of the entity processing the LLO
 *   - crewai.crew.tasks_output: Tasks output data from CrewAI (uses gen_ai.system if available)
 *   - crewai.crew.result: Final result from CrewAI crew (uses gen_ai.system if available)
 *
 * - OpenLit:
 *   - gen_ai.prompt: Direct prompt text (treated as user message)
 *   - gen_ai.completion: Direct completion text (treated as assistant message)
 *   - gen_ai.content.revised_prompt: Revised prompt text (treated as system message)
 *   - gen_ai.agent.actual_output: Output from CrewAI agent (treated as assistant message)
 *
 * - OpenInference:
 *   - input.value: Direct input prompt
 *   - output.value: Direct output response
 *   - llm.input_messages.{n}.message.content: Individual structured input messages
 *   - llm.input_messages.{n}.message.role: Role for input messages
 *   - llm.output_messages.{n}.message.content: Individual structured output messages
 *   - llm.output_messages.{n}.message.role: Role for output messages
 *   - llm.model_name: Model name used for the LLM operation
 */
export class LLOHandler {
  private loggerProvider: LoggerProvider;
  private eventLoggerProvider: EventLoggerProvider;
  private eventLogger: EventLogger;

  /**
   * Initialize an LLOHandler with the specified logger provider.
   *
   * This constructor sets up the event logger provider, configures the event logger,
   * and initializes the patterns used to identify LLO attributes.
   *
   * @param loggerProvider The OpenTelemetry LoggerProvider used for emitting events.
   *     Global LoggerProvider instance injected from our AwsOpenTelemetryConfigurator
   */
  public constructor(loggerProvider: LoggerProvider) {
    this.loggerProvider = loggerProvider;

    this.eventLoggerProvider = new EventLoggerProvider(this.loggerProvider);
    this.eventLogger = this.eventLoggerProvider.getEventLogger('gen_ai.events');
  }

  /**
   * Processes a sequence of spans to extract and filter LLO attributes.
   *
   * For each span, this method:
   * 1. Extracts LLO attributes and emits them as Gen AI Events
   * 2. Filters out LLO attributes from the span to maintain privacy
   * 3. Processes any LLO attributes in span events
   * 4. Preserves non-LLO attributes in the span
   *
   * Handles LLO attributes from multiple frameworks:
   * - Standard Gen AI (structured prompt/completion pattern)
   * - Traceloop (entity input/output pattern)
   * - OpenLit (direct prompt/completion pattern)
   * - OpenInference (input/output value and structured messages pattern)
   *
   * @param spans An array of OpenTelemetry ReadableSpan objects to process
   * @returns {ReadableSpan[]} Modified spans with LLO attributes removed
   */
  public processSpans(spans: ReadableSpan[]): ReadableSpan[] {
    const modifiedSpans: ReadableSpan[] = [];

    for (const span of spans) {
      this.emitLloAttributes(span, span.attributes);
      const updatedAttributes = this.filterAttributes(span.attributes);

      const mutableSpan: Mutable<ReadableSpan> = span;
      mutableSpan.attributes = updatedAttributes;

      this.processSpanEvents(span);

      modifiedSpans.push(span);
    }
    return modifiedSpans;
  }

  /**
   * Process events within a span to extract and filter LLO attributes.
   *
   * For each event in the span, this method:
   * 1. Emits LLO attributes found in event attributes as Gen AI Events
   * 2. Filters out LLO attributes from event attributes
   * 3. Creates updated events with filtered attributes
   * 4. Replaces the original span events with updated events
   *
   * This ensures that LLO attributes are properly handled even when they appear
   * in span events rather than directly in the span's attributes.
   *
   * @param span The ReadableSpan to process events for
   */
  public processSpanEvents(span: ReadableSpan) {
    if (!span.events) {
      return;
    }

    const updatedEvents: TimedEvent[] = [];

    for (const event of span.events) {
      if (!event.attributes) {
        updatedEvents.push(event);
        continue;
      }

      this.emitLloAttributes(span, event.attributes, event.time);

      const updatedEventAttributes = this.filterAttributes(event.attributes);

      if (Object.keys(updatedEventAttributes).length !== Object.keys(event.attributes).length) {
        const updatedEvent: TimedEvent = {
          time: event.time,
          name: event.name,
        };
        if (event.droppedAttributesCount) {
          updatedEvent.droppedAttributesCount = event.droppedAttributesCount;
        }
        if (updatedEventAttributes) {
          updatedEvent.attributes = updatedEventAttributes;
        }

        updatedEvents.push(updatedEvent);
      } else {
        updatedEvents.push(event);
      }
    }

    const mutableSpan: Mutable<ReadableSpan> = span;
    mutableSpan.events = updatedEvents;
  }

  /**
   * Extract Gen AI Events from LLO attributes and emit them via the event logger.
   *
   * This method:
   * 1. Collects LLO attributes from multiple frameworks using specialized extractors
   * 2. Converts each LLO attribute into appropriate Gen AI Events
   * 3. Emits all collected events through the event logger
   *
   * Supported frameworks:
   * - Standard Gen AI: Structured prompt/completion with roles
   * - Traceloop: Entity input/output and CrewAI outputs
   * - OpenLit: Direct prompt/completion/revised prompt and agent outputs
   * - OpenInference: Direct values and structured messages
   *
   * @param span The source ReadableSpan containing the attributes
   * @param attributes Attributes to process
   * @param eventTimestamp Optional timestamp to override span timestamps
   */
  private emitLloAttributes(
    span: ReadableSpan,
    attributes: Attributes,
    eventTimestamp: HrTime | undefined = undefined
  ) {
    // Quick check if we have any LLO attributes before running extractors
    let hasLloAttrs = false;
    for (const key in attributes) {
      if (this.isLloAttribute(key)) {
        hasLloAttrs = true;
        break;
      }
    }
    if (!hasLloAttrs) {
      return;
    }

    const allEvents: Event[] = [
      ...this.extractGenAiPromptEvents(span, attributes, eventTimestamp),
      ...this.extractGenAiCompletionEvents(span, attributes, eventTimestamp),
      ...this.extractTraceloopEvents(span, attributes, eventTimestamp),
      ...this.extractOpenlitSpanEventAttributes(span, attributes, eventTimestamp),
      ...this.extractOpeninferenceAttributes(span, attributes, eventTimestamp),
    ];

    for (const event of allEvents) {
      this.eventLogger.emit(event);
      diag.debug(`Emitted Gen AI Event: ${event.name}`);
    }
  }

  /**
   * Create a new attributes dictionary with LLO attributes removed.

   * This method creates a new dictionary containing only non-LLO attributes,
   * preserving the original values while filtering out sensitive LLO content.
   * This helps maintain privacy and reduces the size of spans.
   * 
   * @param attributes Span or event attributes
   * @returns {Attributes} New Attributes with LLO attributes removed
   */
  private filterAttributes(attributes: Attributes): Attributes {
    // First check if we need to filter anything
    let hasLloAttrs = false;
    for (const key in attributes) {
      if (this.isLloAttribute(key)) {
        hasLloAttrs = true;
        break;
      }
    }

    // If no LLO attributes found, return the original attributes (no need to copy)
    if (!hasLloAttrs) {
      return attributes;
    }

    // Otherwise, create filtered copy
    const filteredAttributes: Attributes = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (!this.isLloAttribute(key)) {
        filteredAttributes[key] = value;
      }
    }

    return filteredAttributes;
  }

  /**
   * Determine if an attribute key contains LLO content based on pattern matching.
   *
   * Checks attribute keys against two types of patterns:
   * 1. Exact match patterns (complete string equality):
   *    - Traceloop: "traceloop.entity.input", "traceloop.entity.output"
   *    - OpenLit: "gen_ai.prompt", "gen_ai.completion", "gen_ai.content.revised_prompt"
   *    - OpenInference: "input.value", "output.value"
   *
   * 2. Regex match patterns (regular expression matching):
   *    - Standard Gen AI: "gen_ai.prompt.{n}.content", "gen_ai.completion.{n}.content"
   *    - OpenInference: "llm.input_messages.{n}.message.content", "llm.output_messages.{n}.message.content"
   *
   * @param key The attribute key to check
   * @returns {boolean} true if the key matches any LLO pattern, false otherwise
   */
  private isLloAttribute(key: string): boolean {
    // Check exact matches first (O(1) lookup in a set)
    if (exactMatchPatterns.has(key)) {
      return true;
    }

    // Then check regex patterns
    for (const pattern of regexPatterns) {
      if (key.match(pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract Gen AI Events from structured prompt attributes.
   *
   * Processes attributes matching the pattern `gen_ai.prompt.{n}.content` and their
   * associated `gen_ai.prompt.{n}.role` attributes to create appropriate events.
   *
   * Event types are determined by the role:
   * 1. `system` → `gen_ai.system.message` Event
   * 2. `user` → `gen_ai.user.message` Event
   * 3. `assistant` → `gen_ai.assistant.message` Event
   * 4. `function` → `gen_ai.{gen_ai.system}.message` custom Event
   * 5. `unknown` → `gen_ai.{gen_ai.system}.message` custom Event
   *
   * @param span The source ReadableSpan containing the attributes
   * @param attributes Attributes to process
   * @param eventTimestamp Optional timestamp to override span.startTime
   * @returns {Event[]} Events created from prompt attributes
   */
  private extractGenAiPromptEvents(
    span: ReadableSpan,
    attributes: Attributes,
    eventTimestamp: HrTime | undefined = undefined
  ): Event[] {
    // Quick check if any prompt content attributes exist
    let promptContentPatternMatched: boolean = false;
    for (const key in attributes) {
      if (key.match(promptContentPattern)) {
        promptContentPatternMatched = true;
        break;
      }
    }
    if (!promptContentPatternMatched) {
      return [];
    }

    const events: Event[] = [];
    const spanCtx = span.spanContext();
    const genAiSystem = span.attributes['gen_ai.system'] || 'unknown';

    // Use helper method to get appropriate timestamp (prompts are inputs)
    const promptTimestamp = this.getTimestamp(span, eventTimestamp, true);

    // Find all prompt content attributes and their roles
    const promptContentMatches: PromptContent[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      const match = key.match(promptContentPattern);
      if (match) {
        const index = match[1];
        const roleKey = `gen_ai.prompt.${index}.role`;
        const role = attributes[roleKey] || 'unknown';
        promptContentMatches.push({ key, value, role });
      }
    }

    // Create events for each content+role pair
    for (const { key, value, role } of promptContentMatches) {
      const eventAttributes = { 'gen_ai.system': genAiSystem, original_attribute: key };
      const body = { content: value, role: role };

      // Use helper method to determine event name based on role
      const eventName = this.getEventNameForRole(role, genAiSystem);

      const event = this.getGenAiEvent(eventName, spanCtx, promptTimestamp, eventAttributes, body, span);

      events.push(event);
    }

    return events;
  }

  /**
   * Extract Gen AI Events from structured completion attributes.
   *
   * Processes attributes matching the pattern `gen_ai.completion.{n}.content` and their
   * associated `gen_ai.completion.{n}.role` attributes to create appropriate events.
   *
   * Event types are determined by the role:
   * 1. `assistant` → `gen_ai.assistant.message` Event (most common)
   * 2. Other roles → `gen_ai.{gen_ai.system}.message` custom Event
   *
   * @param span The source ReadableSpan containing the attributes
   * @param attributes Attributes to process
   * @param eventTimestamp Optional timestamp to override span.endTime
   * @returns {Event[]} Events created from completion attributes
   */
  private extractGenAiCompletionEvents(
    span: ReadableSpan,
    attributes: Attributes,
    eventTimestamp: HrTime | undefined = undefined
  ): Event[] {
    // Quick check if any completion content attributes exist
    let completionContentPatternMatched: boolean = false;
    for (const key in attributes) {
      if (key.match(completionContentPattern)) {
        completionContentPatternMatched = true;
        break;
      }
    }
    if (!completionContentPatternMatched) {
      return [];
    }

    const events: Event[] = [];
    const spanCtx = span.spanContext();
    const genAiSystem = span.attributes['gen_ai.system'] || 'unknown';

    // Use helper method to get appropriate timestamp (completions are outputs)
    const completionTimestamp = this.getTimestamp(span, eventTimestamp, false);

    // Find all completion content attributes and their roles
    const completionContentMatches: PromptContent[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      const match = key.match(completionContentPattern);
      if (match) {
        const index = match[1];
        const roleKey = `gen_ai.completion.${index}.role`;
        const role = attributes[roleKey] || 'unknown';
        completionContentMatches.push({ key, value, role });
      }
    }

    // Create events for each content+role pair
    for (const { key, value, role } of completionContentMatches) {
      const eventAttributes = { 'gen_ai.system': genAiSystem, original_attribute: key };
      const body = { content: value, role: role };

      // Use helper method to determine event name based on role
      const eventName = this.getEventNameForRole(role, genAiSystem);

      const event = this.getGenAiEvent(eventName, spanCtx, completionTimestamp, eventAttributes, body, span);

      events.push(event);
    }
    return events;
  }

  /**
   * Extract Gen AI Events from Traceloop attributes.
   *
   * Processes Traceloop-specific attributes:
   * - `traceloop.entity.input`: Input data (uses span.startTime)
   * - `traceloop.entity.output`: Output data (uses span.endTime)
   * - `traceloop.entity.name`: Used as the gen_ai.system value when gen_ai.system isn't available
   * - `crewai.crew.tasksOutput`: Tasks output data from CrewAI (uses span.endTime)
   * - `crewai.crew.result`: Final result from CrewAI crew (uses span.endTime)
   *
   * Creates generic `gen_ai.{entity_name}.message` events for both input and output,
   * and assistant message events for CrewAI outputs.
   *
   * For CrewAI-specific attributes (crewai.crew.tasks_output and crewai.crew.result),
   * uses span's gen_ai.system attribute if available, otherwise falls back to traceloop.entity.name.
   *
   * @param span The source ReadableSpan containing the attributes
   * @param attributes Attributes to process
   * @param eventTimestamp Optional timestamp to override span timestamps
   * @returns {Event[]} Events created from Traceloop attributes
   */
  private extractTraceloopEvents(
    span: ReadableSpan,
    attributes: Attributes,
    eventTimestamp: HrTime | undefined = undefined
  ): Event[] {
    // Define the Traceloop attributes we're looking for
    const traceloopKeys = [
      TRACELOOP_ENTITY_INPUT,
      TRACELOOP_ENTITY_OUTPUT,
      TRACELOOP_CREW_TASKS_OUTPUT,
      TRACELOOP_CREW_RESULT,
    ];

    // Quick check if any Traceloop attributes exist
    let traceloopAttributesExist: boolean = false;
    for (const key of traceloopKeys) {
      if (key in attributes) {
        traceloopAttributesExist = true;
        break;
      }
    }
    if (!traceloopAttributesExist) {
      return [];
    }

    const events: Event[] = [];
    const spanCtx = span.spanContext();
    // Use traceloop.entity.name for the gen_ai.system value
    const genAiSystem = span.attributes['traceloop.entity.name'] || 'unknown';

    // Use helper methods to get appropriate timestamps
    const inputTimestamp = this.getTimestamp(span, eventTimestamp, true);
    const outputTimestamp = this.getTimestamp(span, eventTimestamp, false);

    // Standard Traceloop entity attributes
    const traceloopAttrs = [
      { attrKey: TRACELOOP_ENTITY_INPUT, timestamp: inputTimestamp, role: ROLE_USER }, // Treat input as user role
      { attrKey: TRACELOOP_ENTITY_OUTPUT, timestamp: outputTimestamp, role: ROLE_ASSISTANT }, // Treat output as assistant role
    ];

    for (const traceloopAttr of traceloopAttrs) {
      const { attrKey, timestamp, role } = traceloopAttr;
      if (attrKey in attributes) {
        const eventAttributes = { 'gen_ai.system': genAiSystem, original_attribute: attrKey };
        const body = { content: attributes[attrKey], role: role };

        // Custom event name for Traceloop (always use system-specific format)
        const eventName = `gen_ai.${genAiSystem}.message`;

        const event = this.getGenAiEvent(eventName, spanCtx, timestamp, eventAttributes, body, span);
        events.push(event);
      }
    }
    // CrewAI-specific Traceloop attributes
    // For CrewAI attributes, prefer gen_ai.system if available, otherwise use traceloop.entity.name
    const crewaiGenAiSystem = span.attributes['gen_ai.system'] || genAiSystem;

    const crewaiAttrs = [
      { attrKey: TRACELOOP_CREW_TASKS_OUTPUT, timestamp: outputTimestamp, role: ROLE_ASSISTANT },
      { attrKey: TRACELOOP_CREW_RESULT, timestamp: outputTimestamp, role: ROLE_ASSISTANT },
    ];

    for (const crewaiAttr of crewaiAttrs) {
      const { attrKey, timestamp, role } = crewaiAttr;
      if (attrKey in attributes) {
        const eventAttributes = { 'gen_ai.system': crewaiGenAiSystem, original_attribute: attrKey };
        const body = { content: attributes[attrKey], role: role };

        // For CrewAI outputs, use the assistant message event
        const eventName = GEN_AI_ASSISTANT_MESSAGE;

        const event = this.getGenAiEvent(eventName, spanCtx, timestamp, eventAttributes, body, span);
        events.push(event);
      }
    }
    return events;
  }

  /**
   * Extract Gen AI Events from OpenLit direct attributes.

   * OpenLit uses direct key-value pairs for LLO attributes:
   * - `gen_ai.prompt`: Direct prompt text (treated as user message)
   * - `gen_ai.completion`: Direct completion text (treated as assistant message)
   * - `gen_ai.content.revised_prompt`: Revised prompt text (treated as system message)
   * - `gen_ai.agent.actual_output`: Output from CrewAI agent (treated as assistant message)

   * The event timestamps are set based on attribute type:
   * - Prompt and revised prompt: span.startTime
   * - Completion and agent output: span.endTime
   * 
   * @param span The source ReadableSpan containing the attributes
   * @param attributes Attributes to process
   * @param eventTimestamp Optional timestamp to override span timestamps
   * @returns {Event[]} Events created from OpenLit attributes
   */
  private extractOpenlitSpanEventAttributes(
    span: ReadableSpan,
    attributes: Attributes,
    eventTimestamp: HrTime | undefined = undefined
  ): Event[] {
    // Define the OpenLit attributes we're looking for
    const openlitKeys = [
      OPENLIT_PROMPT,
      OPENLIT_COMPLETION,
      OPENLIT_REVISED_PROMPT,
      OPENLIT_AGENT_ACTUAL_OUTPUT,
      OPENLIT_AGENT_HUMAN_INPUT,
    ];

    // Quick check if any OpenLit attributes exist
    let openlitAttributesExist: boolean = false;
    for (const key of openlitKeys) {
      if (key in attributes) {
        openlitAttributesExist = true;
        break;
      }
    }
    if (!openlitAttributesExist) {
      return [];
    }

    const events: Event[] = [];
    const spanCtx = span.spanContext();
    const genAiSystem = span.attributes['gen_ai.system'] || 'unknown';

    // Use helper methods to get appropriate timestamps
    const promptTimestamp = this.getTimestamp(span, eventTimestamp, true);
    const completionTimestamp = this.getTimestamp(span, eventTimestamp, false);

    const openlitEventAttrs = [
      {
        attrKey: OPENLIT_PROMPT,
        timestamp: promptTimestamp,
        role: ROLE_USER,
      }, // Assume user role for direct prompts
      {
        attrKey: OPENLIT_COMPLETION,
        timestamp: completionTimestamp,
        role: ROLE_ASSISTANT,
      }, // Assume assistant role for completions
      {
        attrKey: OPENLIT_REVISED_PROMPT,
        timestamp: promptTimestamp,
        role: ROLE_SYSTEM,
      }, // Assume system role for revised prompts
      {
        attrKey: OPENLIT_AGENT_ACTUAL_OUTPUT,
        timestamp: completionTimestamp,
        role: ROLE_ASSISTANT,
      }, // Assume assistant role for agent output
      {
        attrKey: OPENLIT_AGENT_HUMAN_INPUT,
        timestamp: promptTimestamp,
        role: ROLE_USER,
      }, // Assume user role for agent human input
    ];

    for (const openlitEventAttr of openlitEventAttrs) {
      const { attrKey, timestamp, role } = openlitEventAttr;
      if (attrKey in attributes) {
        const eventAttributes = { 'gen_ai.system': genAiSystem, original_attribute: attrKey };
        const body = { content: attributes[attrKey], role: role };

        // Use helper method to determine event name based on role
        const eventName = this.getEventNameForRole(role, genAiSystem);

        const event = this.getGenAiEvent(eventName, spanCtx, timestamp, eventAttributes, body, span);

        events.push(event);
      }
    }
    return events;
  }

  /**
   * Extract Gen AI Events from OpenInference attributes.
   *
   * OpenInference uses two patterns for LLO attributes:
   * 1. Direct values:
   *    - `input.value`: Direct input prompt (treated as user message)
   *    - `output.value`: Direct output response (treated as assistant message)
   *
   * 2. Structured messages:
   *    - `llm.input_messages.{n}.message.content`: Individual input messages
   *    - `llm.input_messages.{n}.message.role`: Role for input message
   *    - `llm.output_messages.{n}.message.content`: Individual output messages
   *    - `llm.output_messages.{n}.message.role`: Role for output message
   *
   * The LLM model name is extracted from the `llm.model_name` attribute
   * instead of `gen_ai.system` which other frameworks use.
   *
   * Event timestamps are set based on message type:
   * - Input messages: span.startTime
   * - Output messages: span.endTime
   *
   * @param span The source ReadableSpan containing the attributes
   * @param attributes Attributes to process
   * @param eventTimestamp Optional timestamp to override span timestamps
   * @returns {Event[]} Events created from OpenInference attributes
   */
  private extractOpeninferenceAttributes(
    span: ReadableSpan,
    attributes: Attributes,
    eventTimestamp: HrTime | undefined = undefined
  ): Event[] {
    // Define the OpenInference keys/patterns we're looking for
    const openinferenceDirectKeys = [OPENINFERENCE_INPUT_VALUE, OPENINFERENCE_OUTPUT_VALUE];

    // Quick check if any OpenInference attributes exist
    let hasDirectAttrs: boolean = false;
    for (const key of openinferenceDirectKeys) {
      if (key in attributes) {
        hasDirectAttrs = true;
        break;
      }
    }
    let hasInputMsgs: boolean = false;
    for (const key in attributes) {
      if (key.match(openinferenceInputMsgPattern)) {
        hasInputMsgs = true;
        break;
      }
    }
    let hasOutputMsgs: boolean = false;
    for (const key in attributes) {
      if (key.match(openinferenceOutputMsgPattern)) {
        hasOutputMsgs = true;
        break;
      }
    }
    if (!(hasDirectAttrs || hasInputMsgs || hasOutputMsgs)) {
      return [];
    }

    const events: Event[] = [];
    const spanCtx = span.spanContext();
    const genAiSystem = span.attributes['llm.model_name'] || 'unknown';

    // Use helper methods to get appropriate timestamps
    const inputTimestamp = this.getTimestamp(span, eventTimestamp, true);
    const outputTimestamp = this.getTimestamp(span, eventTimestamp, false);

    // Process direct value attributes
    const openinferenceDirectAttrs = [
      { attrKey: OPENINFERENCE_INPUT_VALUE, timestamp: inputTimestamp, role: ROLE_USER },
      { attrKey: OPENINFERENCE_OUTPUT_VALUE, timestamp: outputTimestamp, role: ROLE_ASSISTANT },
    ];

    for (const openinferenceDirectAttr of openinferenceDirectAttrs) {
      const { attrKey, timestamp, role } = openinferenceDirectAttr;
      if (attrKey in attributes) {
        const eventAttributes = { 'gen_ai.system': genAiSystem, original_attribute: attrKey };
        const body = { content: attributes[attrKey], role: role };

        // Use helper method to determine event name based on role
        const eventName = this.getEventNameForRole(role, genAiSystem);

        const event = this.getGenAiEvent(eventName, spanCtx, timestamp, eventAttributes, body, span);

        events.push(event);
      }
    }

    // Process input messages
    const inputMessages: PromptContent[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      const match = key.match(openinferenceInputMsgPattern);
      if (match) {
        const index = match[1];
        const roleKey = `llm.input_messages.${index}.message.role`;
        const role = attributes[roleKey] || ROLE_USER; // Default to user if role not specified
        inputMessages.push({ key, value, role });
      }
    }

    // Create events for input messages
    for (const { key, value, role } of inputMessages) {
      const eventAttributes = { 'gen_ai.system': genAiSystem, original_attribute: key };
      const body = { content: value, role: role };

      // Use helper method to determine event name based on role
      const eventName = this.getEventNameForRole(role, genAiSystem);

      const event = this.getGenAiEvent(eventName, spanCtx, inputTimestamp, eventAttributes, body, span);

      events.push(event);
    }

    // Process output messages
    const outputMessages: PromptContent[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      const match = key.match(openinferenceOutputMsgPattern);
      if (match) {
        const index = match[1];
        const roleKey = `llm.output_messages.${index}.message.role`;
        const role = attributes[roleKey] || ROLE_ASSISTANT; // Default to assistant if role not specified
        outputMessages.push({ key, value, role });
      }
    }

    // Create events for output messages
    for (const { key, value, role } of outputMessages) {
      const eventAttributes = { 'gen_ai.system': genAiSystem, original_attribute: key };
      const body = { content: value, role: role };

      // Use helper method to determine event name based on role
      const eventName = this.getEventNameForRole(role, genAiSystem);

      const event = this.getGenAiEvent(eventName, spanCtx, outputTimestamp, eventAttributes, body, span);

      events.push(event);
    }

    return events;
  }

  /**
   * Map a message role to the appropriate event name.
   *
   * @param role The role of the message (system, user, assistant, etc.)
   * @param genAiSystem The gen_ai system identifier
   * @returns {string} The appropriate event name for the given role
   */
  private getEventNameForRole(role: AttributeValue, genAiSystem: AttributeValue): string {
    if (role === ROLE_SYSTEM) {
      return GEN_AI_SYSTEM_MESSAGE;
    } else if (role === ROLE_USER) {
      return GEN_AI_USER_MESSAGE;
    } else if (role === ROLE_ASSISTANT) {
      return GEN_AI_ASSISTANT_MESSAGE;
    } else {
      return `gen_ai.${genAiSystem}.message`;
    }
  }

  /**
   * Determine the appropriate timestamp to use for an event.
   *
   * @param span The source span
   * @param eventTimestamp Optional override timestamp
   * @param isInput Whether this is an input (true) or output (false) message
   * @returns {number} The timestamp to use for the event
   */
  private getTimestamp(span: ReadableSpan, eventTimestamp: HrTime | undefined, isInput: boolean): HrTime {
    if (eventTimestamp !== undefined) {
      return eventTimestamp;
    }

    if (isInput) {
      return span.startTime;
    } else {
      return span.endTime;
    }
  }

  /**
   * Create and return a Gen AI Event with the specified parameters.
   *
   * This helper method constructs a fully configured OpenTelemetry Event object
   * that includes all necessary fields for proper event propagation and context.
   *
   * @param name Event type name (e.g., gen_ai.system.message, gen_ai.user.message)
   * @param spanCtx Span context to extract trace/span IDs from
   * @param timestamp Timestamp for the event (nanoseconds)
   * @param attributes Additional attributes to include with the event
   * @param data Event body containing content and role information
   * @param span A ReadableSpan associated with the Span context
   * @returns {Event}: A fully configured OpenTelemetry Gen AI Event object with proper trace context propagation
   */
  private getGenAiEvent(
    name: string,
    spanCtx: SpanContext,
    timestamp: TimeInput,
    attributes: Attributes,
    data: AnyValue,
    span: ReadableSpan
  ): Event {
    //[] Workaround to add a Context to an Event.
    // This is needed because a ReadableSpan only provides its SpanContext,
    // but does not provide access to the associated Context. An Event can
    // have a Context, but not a SpanContext. Here we attempt to attach a
    // custom Context that is associated to the ReadableSpan to mimic the
    // ReadableSpan's actual Context.
    const customContext = ROOT_CONTEXT.setValue(SPAN_KEY, span);

    return {
      name: name,
      timestamp: timestamp,
      attributes: attributes,
      data: data,
      context: customContext,
    };
  }
}

// The OpenTelemetry Authors code
const SPAN_KEY = createContextKey('OpenTelemetry Context Key SPAN');
export function createContextKey(description: string) {
  // The specification states that for the same input, multiple calls should
  // return different keys. Due to the nature of the JS dependency management
  // system, this creates problems where multiple versions of some package
  // could hold different keys for the same property.
  //
  // Therefore, we use Symbol.for which returns the same key for the same input.
  return Symbol.for(description);
}
// END The OpenTelemetry Authors code
