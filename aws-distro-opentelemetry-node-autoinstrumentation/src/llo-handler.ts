// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, HrTime, ROOT_CONTEXT, createContextKey } from '@opentelemetry/api';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { AnyValue, SeverityNumber } from '@opentelemetry/api-logs';

const ROLE_SYSTEM = 'system';
const ROLE_USER = 'user';
const ROLE_ASSISTANT = 'assistant';
const SESSION_ID = 'session.id';

// Types of LLO attribute patterns
export enum PatternType {
  INDEXED = 'indexed',
  DIRECT = 'direct',
}

// Configuration for an LLO pattern
interface PatternConfig {
  type: PatternType;
  regex?: string;
  roleKey?: string;
  role?: string;
  defaultRole?: string;
  source: string;
}

interface Message {
  content: string;
  role: string;
  source: string;
}

export const LLO_PATTERNS: { [key: string]: PatternConfig } = {
  'gen_ai.prompt.{index}.content': {
    type: PatternType.INDEXED,
    regex: '^gen_ai\\.prompt\\.(\\d+)\\.content$',
    roleKey: 'gen_ai.prompt.{index}.role',
    defaultRole: 'unknown',
    source: 'prompt',
  },
  'gen_ai.completion.{index}.content': {
    type: PatternType.INDEXED,
    regex: '^gen_ai\\.completion\\.(\\d+)\\.content$',
    roleKey: 'gen_ai.completion.{index}.role',
    defaultRole: 'unknown',
    source: 'completion',
  },
  'llm.input_messages.{index}.message.content': {
    type: PatternType.INDEXED,
    regex: '^llm\\.input_messages\\.(\\d+)\\.message\\.content$',
    roleKey: 'llm.input_messages.{index}.message.role',
    defaultRole: ROLE_USER,
    source: 'input',
  },
  'llm.output_messages.{index}.message.content': {
    type: PatternType.INDEXED,
    regex: '^llm\\.output_messages\\.(\\d+)\\.message\\.content$',
    roleKey: 'llm.output_messages.{index}.message.role',
    defaultRole: ROLE_ASSISTANT,
    source: 'output',
  },
  'traceloop.entity.input': {
    type: PatternType.DIRECT,
    role: ROLE_USER,
    source: 'input',
  },
  'traceloop.entity.output': {
    type: PatternType.DIRECT,
    role: ROLE_ASSISTANT,
    source: 'output',
  },
  'crewai.crew.tasks_output': {
    type: PatternType.DIRECT,
    role: ROLE_ASSISTANT,
    source: 'output',
  },
  'crewai.crew.result': {
    type: PatternType.DIRECT,
    role: ROLE_ASSISTANT,
    source: 'result',
  },
  'gen_ai.prompt': {
    type: PatternType.DIRECT,
    role: ROLE_USER,
    source: 'prompt',
  },
  'gen_ai.completion': {
    type: PatternType.DIRECT,
    role: ROLE_ASSISTANT,
    source: 'completion',
  },
  'gen_ai.content.revised_prompt': {
    type: PatternType.DIRECT,
    role: ROLE_SYSTEM,
    source: 'prompt',
  },
  'gen_ai.agent.actual_output': {
    type: PatternType.DIRECT,
    role: ROLE_ASSISTANT,
    source: 'output',
  },
  'gen_ai.agent.human_input': {
    type: PatternType.DIRECT,
    role: ROLE_USER,
    source: 'input',
  },
  'input.value': {
    type: PatternType.DIRECT,
    role: ROLE_USER,
    source: 'input',
  },
  'output.value': {
    type: PatternType.DIRECT,
    role: ROLE_ASSISTANT,
    source: 'output',
  },
  system_prompt: {
    type: PatternType.DIRECT,
    role: ROLE_SYSTEM,
    source: 'prompt',
  },
  'tool.result': {
    type: PatternType.DIRECT,
    role: ROLE_ASSISTANT,
    source: 'output',
  },
  'llm.prompts': {
    type: PatternType.DIRECT,
    role: ROLE_USER,
    source: 'prompt',
  },
};

/**
 * Utility class for handling Large Language Objects (LLO) in OpenTelemetry spans.
 *
 * LLOHandler performs three primary functions:
 * 1. Identifies Large Language Objects (LLO) content in spans
 * 2. Extracts and transforms these attributes into OpenTelemetry Gen AI Events
 * 3. Filters LLO from spans to maintain privacy and reduce span size
 *
 * The handler uses a configuration-driven approach with a pattern registry that defines
 * all supported LLO attribute patterns and their extraction rules. This makes it easy
 * to add support for new frameworks without modifying the core logic.
 */
export class LLOHandler {
  private loggerProvider: LoggerProvider;
  private exactMatchPatterns: Set<string>;
  private regexPatterns: Array<[RegExp, string, PatternConfig]>;
  private patternConfigs: { [key: string]: PatternConfig };

  /**
   * Initialize an LLOHandler with the specified logger provider.
   *
   * This constructor compiles patterns from the pattern registry for efficient matching.
   *
   * @param loggerProvider The OpenTelemetry LoggerProvider used for emitting log records.
   */
  constructor(loggerProvider: LoggerProvider) {
    this.loggerProvider = loggerProvider;
    this.exactMatchPatterns = new Set();
    this.regexPatterns = [];
    this.patternConfigs = {};
    this.buildPatternMatchers();
  }

  /**
   * Build efficient pattern matching structures from the pattern registry.
   *
   * Creates:
   * - Set of exact match patterns for O(1) lookups
   * - List of compiled regex patterns for indexed patterns
   * - Mapping of patterns to their configurations
   */
  private buildPatternMatchers(): void {
    for (const [patternKey, config] of Object.entries(LLO_PATTERNS)) {
      if (config.type === PatternType.DIRECT) {
        this.exactMatchPatterns.add(patternKey);
        this.patternConfigs[patternKey] = config;
      } else if (config.type === PatternType.INDEXED) {
        if (config.regex) {
          const compiledRegex = new RegExp(config.regex);
          this.regexPatterns.push([compiledRegex, patternKey, config]);
        }
      }
    }
  }

  /**
   * Processes a sequence of spans to extract and filter LLO attributes.
   *
   * For each span, this method:
   * 1. Collects all LLO attributes from span attributes and all span events
   * 2. Emits a single consolidated Gen AI Event with all collected LLO content
   * 3. Filters out LLO attributes from the span and its events to maintain privacy
   * 4. Preserves non-LLO attributes in the span
   *
   * Handles LLO attributes from multiple frameworks:
   * - Traceloop (indexed prompt/completion patterns and entity input/output)
   * - OpenLit (direct prompt/completion patterns, including from span events)
   * - OpenInference (input/output values and structured messages)
   * - Strands SDK (system prompts and tool results)
   * - CrewAI (tasks output and results)
   *
   * @param spans A list of OpenTelemetry ReadableSpan objects to process
   * @returns {ReadableSpan[]} A list of modified spans with LLO attributes removed
   */
  public processSpans(spans: ReadableSpan[]): ReadableSpan[] {
    const modifiedSpans: ReadableSpan[] = [];

    for (const span of spans) {
      // Collect all LLO attributes from both span attributes and events
      const allLloAttributes = this.collectLloAttributesFromSpan(span);

      // Emit a single consolidated event if we found any LLO attributes
      if (Object.keys(allLloAttributes).length > 0) {
        this.emitLloAttributes(span, allLloAttributes);
      }

      // Filter and update span attributes
      const filteredAttributes = this.filterAttributes(span.attributes);
      (span as any).attributes = filteredAttributes;

      // Filter span events
      this.filterSpanEvents(span);

      modifiedSpans.push(span);
    }

    return modifiedSpans;
  }

  /**
   * Collect all LLO attributes from a span's attributes and events.
   *
   * @param span The span to collect LLO attributes from
   * @returns all LLO attributes found in the span
   */
  private collectLloAttributesFromSpan(span: ReadableSpan): Attributes {
    const allLloAttributes: Attributes = {};

    // Collect from span attributes
    if (span.attributes) {
      for (const [key, value] of Object.entries(span.attributes)) {
        if (this.isLloAttribute(key)) {
          allLloAttributes[key] = value;
        }
      }
    }

    // Collect from span events
    if (span.events) {
      for (const event of span.events) {
        if (event.attributes) {
          for (const [key, value] of Object.entries(event.attributes)) {
            if (this.isLloAttribute(key)) {
              allLloAttributes[key] = value;
            }
          }
        }
      }
    }

    return allLloAttributes;
  }

  /**
   * Filter LLO attributes from span events.
   *
   * This method removes LLO attributes from event attributes while preserving
   * the event structure and non-LLO attributes.
   *
   * @param span The ReadableSpan to filter events for
   */
  private filterSpanEvents(span: ReadableSpan): void {
    if (!span.events) {
      return;
    }

    const updatedEvents: TimedEvent[] = [];

    for (const event of span.events) {
      if (!event.attributes) {
        updatedEvents.push(event);
        continue;
      }

      const updatedEventAttributes = this.filterAttributes(event.attributes);

      if (Object.keys(updatedEventAttributes).length !== Object.keys(event.attributes).length) {
        const updatedEvent: TimedEvent = {
          name: event.name,
          time: event.time,
          attributes: updatedEventAttributes,
        };

        updatedEvents.push(updatedEvent);
      } else {
        updatedEvents.push(event);
      }
    }

    (span as any).events = updatedEvents;
  }

  /**
   * Extract LLO attributes and emit them as a single consolidated Gen AI Event.
   *
   * This method:
   * 1. Collects all LLO attributes using the pattern registry
   * 2. Groups them into input and output messages
   * 3. Emits one event per span containing all LLO content
   *
   * The event body format:
   * {
   *   "input": {
   *     "messages": [
   *       {
   *         "role": "system",
   *         "content": "..."
   *       },
   *       {
   *         "role": "user",
   *         "content": "..."
   *       }
   *     ]
   *   },
   *   "output": {
   *     "messages": [
   *       {
   *         "role": "assistant",
   *         "content": "..."
   *       }
   *     ]
   *   }
   * }
   *
   * @param span The source ReadableSpan containing the attributes
   * @param attributes LLO attributes to process
   * @param eventTimestamp Optional timestamp to override span timestamps
   * @returns
   */
  private emitLloAttributes(span: ReadableSpan, attributes: Attributes, eventTimestamp?: HrTime): void {
    if (!attributes || Object.keys(attributes).length === 0) {
      return;
    }

    const allMessages = this.collectAllLloMessages(span, attributes);
    if (allMessages.length === 0) {
      return;
    }

    // Group messages into input/output categories
    const groupedMessages = this.groupMessagesByType(allMessages);

    // Build event body
    const eventBody: AnyValue = {};
    if (groupedMessages.input.length > 0) {
      eventBody.input = { messages: groupedMessages.input };
    }
    if (groupedMessages.output.length > 0) {
      eventBody.output = { messages: groupedMessages.output };
    }

    if (Object.keys(eventBody).length === 0) {
      return;
    }

    // Create and emit the log record
    // This replaces the deprecated @opentelemetry/sdk-events EventLogger pattern
    const timestamp = eventTimestamp || span.endTime;
    const logger = this.loggerProvider.getLogger(span.instrumentationScope.name);

    // Workaround to add a custom-made Context to the log record so that it has the correct
    // associated traceId, spanId, flag. This is needed because a ReadableSpan only provides
    // its SpanContext, but does not provide access to its associated Context.
    // When a log record instance is created, it will use this context to extract the SpanContext.
    // - https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/sdk-logs/src/LogRecord.ts
    const customContext = ROOT_CONTEXT.setValue(OTEL_SPAN_KEY, span);

    // Build attributes with event.name (for backwards compatibility with EventLogger behavior)
    // and session ID if present
    const logAttributes: Attributes = {
      'event.name': span.instrumentationScope.name,
    };
    if (span.attributes[SESSION_ID]) {
      logAttributes[SESSION_ID] = span.attributes[SESSION_ID];
    }

    // Use eventName field to set the event name (aligns with Python LLO handler's use of 'name')
    // Also keep event.name in attributes for backwards compatibility with EventLogger
    // See: https://github.com/aws-observability/aws-otel-python-instrumentation/blob/main/aws-opentelemetry-distro/src/amazon/opentelemetry/distro/llo_handler.py#L534
    logger.emit({
      eventName: span.instrumentationScope.name,
      timestamp: timestamp,
      body: eventBody,
      context: customContext,
      attributes: logAttributes,
      severityNumber: SeverityNumber.INFO,
    });
  }

  /**
   * Collect all LLO messages from attributes using the pattern registry.
   *
   * This is the main collection method that processes all patterns defined
   * in the registry and extracts messages accordingly.
   *
   * @param span The source ReadableSpan containing the attributes
   * @param attributes Attributes to process
   * @returns {Message[]} LLO messages from attributes using the pattern registry
   */
  private collectAllLloMessages(span: ReadableSpan, attributes: Attributes): Message[] {
    const messages: Message[] = [];

    if (!attributes) return messages;

    for (const [attrKey, value] of Object.entries(attributes)) {
      if (this.exactMatchPatterns.has(attrKey)) {
        const config = this.patternConfigs[attrKey];
        messages.push({
          content: value as string,
          role: config.role || 'unknown',
          source: config.source || 'unknown',
        });
      }
    }

    messages.push(...this.collectIndexedMessages(attributes));

    return messages;
  }

  /**
   * Collect messages from indexed patterns (e.g., gen_ai.prompt.0.content).
   * Handles patterns with numeric indices and their associated role attributes.
   *
   * @param attributes Attributes to process
   * @returns {Message[]}
   */
  private collectIndexedMessages(attributes: Attributes): Message[] {
    const indexedMessages: (Message & { pattern: string; index: number })[] = [];

    for (const [attrKey, value] of Object.entries(attributes)) {
      for (const [regex, patternKey, config] of this.regexPatterns) {
        const match = attrKey.match(regex);
        if (match) {
          const index = parseInt(match[1], 10);

          let role = config.defaultRole || 'unknown';
          if (config.roleKey) {
            const roleKey = config.roleKey.replace('{index}', index.toString());
            const roleValue = attributes[roleKey];
            if (typeof roleValue === 'string') {
              role = roleValue;
            }
          }

          indexedMessages.push({
            content: value as string,
            role,
            source: config.source,
            pattern: patternKey,
            index: index,
          });
          break;
        }
      }
    }

    return indexedMessages
      .sort((a, b) => (a.pattern !== b.pattern ? a.pattern.localeCompare(b.pattern) : a.index - b.index))
      .map(({ content, role, source }) => ({ content, role, source }));
  }

  private groupMessagesByType(messages: Message[]) {
    const input: { role: string; content: string }[] = [];
    const output: { role: string; content: string }[] = [];

    for (const message of messages) {
      const { role, content, source } = message;
      const formattedMessage = { role, content };

      if (role === ROLE_SYSTEM || role === ROLE_USER) {
        input.push(formattedMessage);
      } else if (role === ROLE_ASSISTANT) {
        output.push(formattedMessage);
      } else {
        // Route based on source for non-standard roles
        if (['completion', 'output', 'result'].some(key => source.includes(key))) {
          output.push(formattedMessage);
        } else {
          input.push(formattedMessage);
        }
      }
    }

    return { input, output };
  }

  /**
   * Create new attributes with LLO attributes removed.
   *
   * This method creates an attributes object containing only non-LLO attributes,
   * preserving the original values while filtering out sensitive LLO content.
   * This helps maintain privacy and reduces the size of spans.
   *
   * @param attributes Original span or event attributes
   * @returns {Attributes} New attributes with LLO attributes removed, or empty object if input is undefined
   */
  private filterAttributes(attributes: Attributes | undefined): Attributes {
    if (!attributes) {
      return {};
    }

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
   * Uses the pattern registry to check if a key matches any LLO pattern.
   *
   * @param key The attribute key to check
   * @returns {boolean} true if the key matches any LLO pattern, false otherwise
   */
  private isLloAttribute(key: string): boolean {
    if (this.exactMatchPatterns.has(key)) {
      return true;
    }

    for (const [regex] of this.regexPatterns) {
      if (regex.test(key)) {
        return true;
      }
    }

    return false;
  }
}

// Defined by OTel in:
// - https://github.com/open-telemetry/opentelemetry-js/blob/v1.9.0/api/src/trace/context-utils.ts#L24-L27
export const OTEL_SPAN_KEY = createContextKey('OpenTelemetry Context Key SPAN');
