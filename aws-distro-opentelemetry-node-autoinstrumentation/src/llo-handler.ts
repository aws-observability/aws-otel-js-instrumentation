// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import { diag, Attributes, TimeInput, ROOT_CONTEXT, SpanContext, HrTime } from '@opentelemetry/api';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { EventLoggerProvider } from '@opentelemetry/sdk-events';
import { EventLogger, Event } from '@opentelemetry/api-events';
import { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { AnyValue } from '@opentelemetry/api-logs';
import { Mutable } from './utils';

// Message event types
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

/**
 * Utility class for handling Large Language Objects (LLO) in OpenTelemetry spans.
 *
 * LLOHandler performs three primary functions:
 * 1. Identifies Large Language Objects (LLO) content in spans
 * 2. Extracts and transforms these attributes into OpenTelemetry Gen AI Events
 * 3. Filters LLO from spans to maintain privacy and reduce span size
 *
 * Supported frameworks and their attribute patterns:
 * - Traceloop:
 *   - traceloop.entity.input: Input text for LLM operations
 *   - traceloop.entity.output: Output text from LLM operations
 *   - traceloop.entity.name: Name of the entity processing the LLO
 *   - crewai.crew.tasks_output: Tasks output data from CrewAI (uses gen_ai.system if available)
 *   - crewai.crew.result: Final result from CrewAI crew (uses gen_ai.system if available)
 *
 * TODO: Support other frameworks
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
   * - Traceloop (entity input/output pattern)
   *
   * TODO: Support other frameworks
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
   * - Traceloop: Entity input/output and CrewAI outputs
   *
   * TODO: Support other frameworks
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

    const allEvents: Event[] = [...this.extractTraceloopEvents(span, attributes, eventTimestamp)];

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
    // Workaround to add a Context to an Event.
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
