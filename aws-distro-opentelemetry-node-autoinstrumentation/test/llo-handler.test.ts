// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as api from '@opentelemetry/api-events';
import { Attributes, SpanContext, SpanKind } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import expect from 'expect';
import { LLOHandler } from '../src/llo-handler';
import { EventLogger, EventLoggerProvider } from '@opentelemetry/sdk-events';
import { Logger, LoggerOptions, LogRecord } from '@opentelemetry/api-logs';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import * as sinon from 'sinon';
import { Mutable } from '../src/utils';

describe('LLOHandlerTest', () => {
  const loggerMock: Logger = {
    emit: (logRecord: LogRecord) => {},
  };
  let loggerProviderMock: LoggerProvider;
  let eventLoggerMock: api.EventLogger;
  let eventLoggerProviderMock: EventLoggerProvider;
  let lloHandler: LLOHandler;

  before(() => {
    loggerProviderMock = new LoggerProvider();
    loggerProviderMock.getLogger = (name: string, version?: string, options?: LoggerOptions) => {
      return loggerMock;
    };

    lloHandler = new LLOHandler(loggerProviderMock);
    eventLoggerProviderMock = lloHandler['eventLoggerProvider'];
    eventLoggerMock = lloHandler['eventLogger'];
  });

  afterEach(() => {
    sinon.restore();
  });

  /**
   * Helper method to create a mock span with given attributes
   */
  function createMockSpan(
    attributes: Attributes | undefined = undefined,
    kind: SpanKind = SpanKind.INTERNAL
  ): Mutable<ReadableSpan> {
    // Configure spanData
    const mockSpanData: ReadableSpan = {
      name: 'spanName',
      kind: kind,
      spanContext: () => {
        const spanContext: SpanContext = {
          traceId: '00000000000000000000000000000008',
          spanId: '0000000000000009',
          traceFlags: 0,
          isRemote: false,
        };
        return spanContext;
      },
      startTime: [1234567890, 0],
      endTime: [1234567891, 0],
      status: { code: 0 },
      attributes: {},
      links: [],
      events: [],
      duration: [0, 1],
      ended: true,
      resource: new Resource({}),
      instrumentationLibrary: { name: 'mockedLibrary' },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    if (attributes) {
      (mockSpanData as any).attributes = attributes;
    }
    return mockSpanData;
  }

  /**
   * Test initialization of LLOHandler
   */
  it('testInit', () => {
    expect(lloHandler['loggerProvider']).toEqual(loggerProviderMock);
    expect(lloHandler['eventLoggerProvider']).toEqual(eventLoggerProviderMock);

    expect((eventLoggerMock as EventLogger)['_logger']).toBe(loggerMock);
  });

  /**
   * Test isLloAttribute method with matching patterns
   */
  it('testIsLloAttributeMatch', () => {
    expect(lloHandler['isLloAttribute']('gen_ai.prompt.0.content')).toBeTruthy();
    expect(lloHandler['isLloAttribute']('gen_ai.prompt.123.content')).toBeTruthy();
  });

  /**
   * Test isLloAttribute method with non-matching patterns
   */
  it('testIsLloAttributeNoMatch', () => {
    expect(lloHandler['isLloAttribute']('gen_ai.prompt.content')).toBeFalsy();
    expect(lloHandler['isLloAttribute']('gen_ai.prompt.abc.content')).toBeFalsy();
    expect(lloHandler['isLloAttribute']('some.other.attribute')).toBeFalsy();
  });

  /**
   * Test isLloAttribute method with Traceloop patterns
   */
  it('testIsLloAttributeTraceloopMatch', () => {
    // Test exact matches for Traceloop attributes
    expect(lloHandler['isLloAttribute']('traceloop.entity.input')).toBeTruthy();
    expect(lloHandler['isLloAttribute']('traceloop.entity.output')).toBeTruthy();
  });

  /**
   * Test isLloAttribute method with OpenLit patterns
   */
  it('testIsLloAttributeOpenlitMatch', () => {
    // Test exact matches for direct OpenLit attributes
    expect(lloHandler['isLloAttribute']('gen_ai.prompt')).toBeTruthy();
    expect(lloHandler['isLloAttribute']('gen_ai.completion')).toBeTruthy();
    expect(lloHandler['isLloAttribute']('gen_ai.content.revised_prompt')).toBeTruthy();
  });

  /**
   * Test isLloAttribute method with OpenInference patterns
   */
  it('testIsLloAttributeOpeninferenceMatch', () => {
    // Test exact matches
    expect(lloHandler['isLloAttribute']('input.value')).toBeTruthy();
    expect(lloHandler['isLloAttribute']('output.value')).toBeTruthy();

    // Test regex matches
    expect(lloHandler['isLloAttribute']('llm.input_messages.0.message.content')).toBeTruthy();
    expect(lloHandler['isLloAttribute']('llm.output_messages.123.message.content')).toBeTruthy();
  });

  /**
   * Test isLloAttribute method with CrewAI patterns
   */
  it('testIsLloAttributeCrewaiMatch', () => {
    // Test exact match for CrewAI attributes (handled by Traceloop and OpenLit)
    expect(lloHandler['isLloAttribute']('gen_ai.agent.actual_output')).toBeTruthy();
    expect(lloHandler['isLloAttribute']('gen_ai.agent.human_input')).toBeTruthy();
    expect(lloHandler['isLloAttribute']('crewai.crew.tasks_output')).toBeTruthy();
    expect(lloHandler['isLloAttribute']('crewai.crew.result')).toBeTruthy();
  });

  /**
   * Test filterAttributes method
   */
  it('testFilterAttributes', () => {
    const attributes = {
      'gen_ai.prompt.0.content': 'test content',
      'gen_ai.prompt.0.role': 'user',
      'normal.attribute': 'value',
      'another.normal.attribute': 123,
    };

    const filtered = lloHandler['filterAttributes'](attributes);

    expect(filtered['gen_ai.prompt.0.content']).toBeUndefined();
    expect(filtered['gen_ai.prompt.0.role']).toBeDefined();
    expect(filtered['normal.attribute']).toBeDefined();
    expect(filtered['another.normal.attribute']).toBeDefined();
  });

  /**
   * Test extractGenAiPromptEvents with system role
   */
  it('testextractGenAiPromptEventsSystemRole', () => {
    const attributes = {
      'gen_ai.prompt.0.content': 'system instruction',
      'gen_ai.prompt.0.role': 'system',
      'gen_ai.system': 'openai',
    };

    const span = createMockSpan(attributes);

    const events = lloHandler['extractGenAiPromptEvents'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.system.message');
    expect((event as any).data['content']).toEqual('system instruction');
    expect((event as any).data['role']).toEqual('system');
    expect(event.attributes!['gen_ai.system']).toEqual('openai');
    expect(event.attributes!['original_attribute']).toEqual('gen_ai.prompt.0.content');
  });

  /**
   * Test extractGenAiPromptEvents with user role
   */
  it('testextractGenAiPromptEventsUserRole', () => {
    const attributes = {
      'gen_ai.prompt.0.content': 'user question',
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.system': 'anthropic',
    };

    const span = createMockSpan(attributes);

    const events = lloHandler['extractGenAiPromptEvents'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.user.message');
    expect((event as any).data['content']).toEqual('user question');
    expect((event as any).data['role']).toEqual('user');
    expect(event.attributes!['gen_ai.system']).toEqual('anthropic');
    expect(event.attributes!['original_attribute']).toEqual('gen_ai.prompt.0.content');
  });

  /**
   * Test extractGenAiPromptEvents with assistant role
   */
  it('testextractGenAiPromptEventsAssistantRole', () => {
    const attributes = {
      'gen_ai.prompt.1.content': 'assistant response',
      'gen_ai.prompt.1.role': 'assistant',
      'gen_ai.system': 'anthropic',
    };

    const span = createMockSpan(attributes);

    const events = lloHandler['extractGenAiPromptEvents'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.assistant.message');
    expect((event as any).data['content']).toEqual('assistant response');
    expect((event as any).data['role']).toEqual('assistant');
    expect(event.attributes!['gen_ai.system']).toEqual('anthropic');
    expect(event.attributes!['original_attribute']).toEqual('gen_ai.prompt.1.content');
  });

  /**
   * Test extractGenAiPromptEvents with function role
   */
  it('testextractGenAiPromptEventsFunctionRole', () => {
    const attributes = {
      'gen_ai.prompt.2.content': 'function data',
      'gen_ai.prompt.2.role': 'function',
      'gen_ai.system': 'openai',
    };

    const span = createMockSpan(attributes);
    const events = lloHandler['extractGenAiPromptEvents'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.openai.message');
    expect((event as any).data['content']).toEqual('function data');
    expect((event as any).data['role']).toEqual('function');
    expect(event.attributes!['gen_ai.system']).toEqual('openai');
    expect(event.attributes!['original_attribute']).toEqual('gen_ai.prompt.2.content');
  });

  /**
   * Test extractGenAiPromptEvents with unknown role
   */
  it('testextractGenAiPromptEventsUnknownRole', () => {
    const attributes = {
      'gen_ai.prompt.3.content': 'unknown type content',
      'gen_ai.prompt.3.role': 'unknown',
      'gen_ai.system': 'bedrock',
    };

    const span = createMockSpan(attributes);
    const events = lloHandler['extractGenAiPromptEvents'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.bedrock.message');
    expect((event as any).data['content']).toEqual('unknown type content');
    expect((event as any).data['role']).toEqual('unknown');
    expect(event.attributes!['gen_ai.system']).toEqual('bedrock');
  });

  /**
   * Test extractGenAiCompletionEvents with assistant role
   */
  it('testextractGenAiCompletionEventsAssistantRole', () => {
    const attributes = {
      'gen_ai.completion.0.content': 'assistant completion',
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.system': 'openai',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0]; // end time for completion events

    const events = lloHandler['extractGenAiCompletionEvents'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.assistant.message');
    expect((event as any).data['content']).toEqual('assistant completion');
    expect((event as any).data['role']).toEqual('assistant');
    expect(event.attributes!['gen_ai.system']).toEqual('openai');
    expect(event.timestamp).toEqual([1234567899, 0]);
  });

  /**
   * Test extractGenAiCompletionEvents with non-assistant role
   */
  it('testextractGenAiCompletionEventsOtherRole', () => {
    const attributes = {
      'gen_ai.completion.1.content': 'other completion',
      'gen_ai.completion.1.role': 'other',
      'gen_ai.system': 'anthropic',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractGenAiCompletionEvents'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.anthropic.message');
    expect((event as any).data['content']).toEqual('other completion');
    expect(event.attributes!['gen_ai.system']).toEqual('anthropic');
  });

  /**
   * Test extractTraceloopEvents with standard Traceloop attributes
   */
  it('testextractTraceloopEvents', () => {
    const attributes = {
      'traceloop.entity.input': 'input data',
      'traceloop.entity.output': 'output data',
      'traceloop.entity.name': 'my_entity',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractTraceloopEvents'](span, attributes);

    expect(events.length).toEqual(2);

    const inputEvent = events[0];
    expect(inputEvent.name).toEqual('gen_ai.my_entity.message');
    expect((inputEvent.data as any)['content']).toEqual('input data');
    expect(inputEvent.attributes!['gen_ai.system']).toEqual('my_entity');
    expect(inputEvent.attributes!['original_attribute']).toEqual('traceloop.entity.input');
    expect(inputEvent.timestamp).toEqual([1234567890, 0]); // startTime

    const outputEvent = events[1];
    expect(outputEvent.name).toEqual('gen_ai.my_entity.message');
    expect((outputEvent.data as any)['content']).toEqual('output data');
    expect(outputEvent.attributes!['gen_ai.system']).toEqual('my_entity');
    expect(outputEvent.attributes!['original_attribute']).toEqual('traceloop.entity.output');
    expect(outputEvent.timestamp).toEqual([1234567899, 0]); // endTime
  });

  /**
   * Test extractTraceloopEvents with all Traceloop attributes including CrewAI outputs
   */
  it('testExtractTraceloopAllAttributes', () => {
    const attributes = {
      'traceloop.entity.input': 'input data',
      'traceloop.entity.output': 'output data',
      'crewai.crew.tasks_output': "[TaskOutput(description='Task 1', output='Result 1')]",
      'crewai.crew.result': 'Final crew result',
      'traceloop.entity.name': 'crewai_agent',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractTraceloopEvents'](span, attributes);

    expect(events.length).toEqual(4);

    // Get a map of original attributes to events
    const eventsByAttr: { [key: string]: api.Event } = Object.fromEntries(
      events.map(event => [event.attributes!['original_attribute'], event])
    );

    // Check all expected attributes are present
    expect(eventsByAttr['traceloop.entity.input']).toBeDefined();
    expect(eventsByAttr['traceloop.entity.output']).toBeDefined();
    expect(eventsByAttr['crewai.crew.tasks_output']).toBeDefined();
    expect(eventsByAttr['crewai.crew.result']).toBeDefined();

    // Check standard Traceloop events
    const inputEvent = eventsByAttr['traceloop.entity.input'];
    expect(inputEvent.name).toEqual('gen_ai.crewai_agent.message');
    expect((inputEvent.data as any)['role']).toEqual('user');

    const outputEvent = eventsByAttr['traceloop.entity.output'];
    expect(outputEvent.name).toEqual('gen_ai.crewai_agent.message');
    expect((outputEvent.data as any)['role']).toEqual('assistant');

    // Check CrewAI events
    const tasksEvent = eventsByAttr['crewai.crew.tasks_output'];
    expect(tasksEvent.name).toEqual('gen_ai.assistant.message');
    expect((tasksEvent.data as any)['role']).toEqual('assistant');

    const resultEvent = eventsByAttr['crewai.crew.result'];
    expect(resultEvent.name).toEqual('gen_ai.assistant.message');
    expect((resultEvent.data as any)['role']).toEqual('assistant');
  });

  /**
   * Test extractOpenlitSpanEventAttributes with direct prompt attribute
   */
  it('testExtractOpenlitDirectPrompt', () => {
    const attributes = { 'gen_ai.prompt': 'user direct prompt', 'gen_ai.system': 'openlit' };

    const span = createMockSpan(attributes);

    const events = lloHandler['extractOpenlitSpanEventAttributes'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.user.message');
    expect((event as any).data['content']).toEqual('user direct prompt');
    expect((event as any).data['role']).toEqual('user');
    expect(event.attributes!['gen_ai.system']).toEqual('openlit');
    expect(event.attributes!['original_attribute']).toEqual('gen_ai.prompt');
    expect(event.timestamp).toEqual([1234567890, 0]); // startTime
  });

  /**
   * Test extractOpenlitSpanEventAttributes with direct completion attribute
   */
  it('testExtractOpenlitDirectCompletion', () => {
    const attributes = { 'gen_ai.completion': 'assistant direct completion', 'gen_ai.system': 'openlit' };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractOpenlitSpanEventAttributes'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.assistant.message');
    expect((event as any).data['content']).toEqual('assistant direct completion');
    expect((event as any).data['role']).toEqual('assistant');
    expect(event.attributes!['gen_ai.system']).toEqual('openlit');
    expect(event.attributes!['original_attribute']).toEqual('gen_ai.completion');
    expect(event.timestamp).toEqual([1234567899, 0]); // endTime
  });

  /**
   * Test extractOpenlitSpanEventAttributes with all OpenLit attributes
   */
  it('testExtractOpenlitAllAttributes', () => {
    const attributes = {
      'gen_ai.prompt': 'user prompt',
      'gen_ai.completion': 'assistant response',
      'gen_ai.content.revised_prompt': 'revised prompt',
      'gen_ai.agent.actual_output': 'agent output',
      'gen_ai.agent.human_input': 'human input to agent',
      'gen_ai.system': 'langchain',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractOpenlitSpanEventAttributes'](span, attributes);

    expect(events.length).toEqual(5);

    // Check that all events have the correct system
    for (const event of events) {
      expect(event.attributes!['gen_ai.system']).toEqual('langchain');
    }

    // Check we have the expected event types
    const eventTypes: Set<string> = new Set(events.map(event => event.name));

    expect(eventTypes.has('gen_ai.user.message')).toBeTruthy();
    expect(eventTypes.has('gen_ai.assistant.message')).toBeTruthy();
    expect(eventTypes.has('gen_ai.system.message')).toBeTruthy();

    // Verify counts of user messages (should be 2 - prompt and human input)
    const userEvents = events.filter(event => event.name === 'gen_ai.user.message');
    expect(userEvents.length).toEqual(2);

    // Check original attributes
    const originalAttrs = new Set();
    events.forEach(event => {
      if (event.attributes) originalAttrs.add(event.attributes['original_attribute']);
    });

    expect(originalAttrs.has('gen_ai.prompt')).toBeTruthy();
    expect(originalAttrs.has('gen_ai.completion')).toBeTruthy();
    expect(originalAttrs.has('gen_ai.content.revised_prompt')).toBeTruthy();
    expect(originalAttrs.has('gen_ai.agent.actual_output')).toBeTruthy();
    expect(originalAttrs.has('gen_ai.agent.human_input')).toBeTruthy();
  });

  /**
   * Test extractOpenlitSpanEventAttributes with revised prompt attribute
   */
  it('testExtractOpenlitRevisedPrompt', () => {
    const attributes = { 'gen_ai.content.revised_prompt': 'revised system prompt', 'gen_ai.system': 'openlit' };

    const span = createMockSpan(attributes);

    const events = lloHandler['extractOpenlitSpanEventAttributes'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.system.message');
    expect((event as any).data['content']).toEqual('revised system prompt');
    expect((event as any).data['role']).toEqual('system');
    expect(event.attributes!['gen_ai.system']).toEqual('openlit');
    expect(event.attributes!['original_attribute']).toEqual('gen_ai.content.revised_prompt');
    expect(event.timestamp).toEqual([1234567890, 0]); // startTime
  });

  /**
   * Test extractOpeninferenceAttributes with direct input/output values
   */
  it('testExtractOpeninferenceDirectAttributes', () => {
    const attributes = {
      'input.value': 'user prompt',
      'output.value': 'assistant response',
      'llm.model_name': 'gpt-4',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractOpeninferenceAttributes'](span, attributes);

    expect(events.length).toEqual(2);

    const inputEvent = events[0];
    expect(inputEvent.name).toEqual('gen_ai.user.message');
    expect((inputEvent.data as any)['content']).toEqual('user prompt');
    expect((inputEvent.data as any)['role']).toEqual('user');
    expect(inputEvent.attributes!['gen_ai.system']).toEqual('gpt-4');
    expect(inputEvent.attributes!['original_attribute']).toEqual('input.value');
    expect(inputEvent.timestamp).toEqual([1234567890, 0]); // startTime

    const outputEvent = events[1];
    expect(outputEvent.name).toEqual('gen_ai.assistant.message');
    expect((outputEvent.data as any)['content']).toEqual('assistant response');
    expect((outputEvent.data as any)['role']).toEqual('assistant');
    expect(outputEvent.attributes!['gen_ai.system']).toEqual('gpt-4');
    expect(outputEvent.attributes!['original_attribute']).toEqual('output.value');
    expect(outputEvent.timestamp).toEqual([1234567899, 0]); // endTime
  });

  /**
   * Test extractOpeninferenceAttributes with structured input messages
   */
  it('testExtractOpeninferenceStructuredInputMessages', () => {
    const attributes = {
      'llm.input_messages.0.message.content': 'system prompt',
      'llm.input_messages.0.message.role': 'system',
      'llm.input_messages.1.message.content': 'user message',
      'llm.input_messages.1.message.role': 'user',
      'llm.model_name': 'claude-3',
    };

    const span = createMockSpan(attributes);

    const events = lloHandler['extractOpeninferenceAttributes'](span, attributes);

    expect(events.length).toEqual(2);

    const systemEvent = events[0];
    expect(systemEvent.name).toEqual('gen_ai.system.message');
    expect((systemEvent.data as any)['content']).toEqual('system prompt');
    expect((systemEvent.data as any)['role']).toEqual('system');
    expect(systemEvent.attributes!['gen_ai.system']).toEqual('claude-3');
    expect(systemEvent.attributes!['original_attribute']).toEqual('llm.input_messages.0.message.content');

    const userEvent = events[1];
    expect(userEvent.name).toEqual('gen_ai.user.message');
    expect((userEvent.data as any)['content']).toEqual('user message');
    expect((userEvent.data as any)['role']).toEqual('user');
    expect(userEvent.attributes!['gen_ai.system']).toEqual('claude-3');
    expect(userEvent.attributes!['original_attribute']).toEqual('llm.input_messages.1.message.content');
  });

  /**
   * Test extractOpeninferenceAttributes with structured output messages
   */
  it('testExtractOpeninferenceStructuredOutputMessages', () => {
    const attributes = {
      'llm.output_messages.0.message.content': 'assistant response',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.model_name': 'llama-3',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractOpeninferenceAttributes'](span, attributes);

    expect(events.length).toEqual(1);

    const outputEvent = events[0];
    expect(outputEvent.name).toEqual('gen_ai.assistant.message');
    expect((outputEvent.data as any)['content']).toEqual('assistant response');
    expect((outputEvent.data as any)['role']).toEqual('assistant');
    expect(outputEvent.attributes!['gen_ai.system']).toEqual('llama-3');
    expect(outputEvent.attributes!['original_attribute']).toEqual('llm.output_messages.0.message.content');
    expect(outputEvent.timestamp).toEqual([1234567899, 0]); // endTime
  });

  /**
   * Test extractOpeninferenceAttributes with a mix of all attribute types
   */
  it('testExtractOpeninferenceMixedAttributes', () => {
    const attributes = {
      'input.value': 'direct input',
      'output.value': 'direct output',
      'llm.input_messages.0.message.content': 'message input',
      'llm.input_messages.0.message.role': 'user',
      'llm.output_messages.0.message.content': 'message output',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.model_name': 'bedrock.claude-3',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractOpeninferenceAttributes'](span, attributes);

    expect(events.length).toEqual(4);

    // Verify all events have the correct model name
    for (const event of events) {
      expect(event.attributes!['gen_ai.system']).toEqual('bedrock.claude-3');
    }

    // We don't need to check every detail since other tests do that,
    // but we can verify we got all the expected event types
    const eventTypes = new Set(events.map(event => event.name));

    expect(eventTypes.has('gen_ai.user.message')).toBeTruthy();
    expect(eventTypes.has('gen_ai.assistant.message')).toBeTruthy();

    // Verify original attributes were correctly captured
    const originalAttrs = new Set();
    events.forEach(event => {
      if (event.attributes) originalAttrs.add(event.attributes['original_attribute']);
    });
    expect(originalAttrs.has('input.value')).toBeTruthy();
    expect(originalAttrs.has('output.value')).toBeTruthy();
    expect(originalAttrs.has('llm.input_messages.0.message.content')).toBeTruthy();
    expect(originalAttrs.has('llm.output_messages.0.message.content')).toBeTruthy();
  });

  /**
   * Test extractOpenlitSpanEventAttributes with agent actual output attribute
   */
  it('testExtractOpenlitAgentActualOutput', () => {
    const attributes = { 'gen_ai.agent.actual_output': 'Agent task output result', 'gen_ai.system': 'crewai' };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractOpenlitSpanEventAttributes'](span, attributes);

    expect(events.length).toEqual(1);

    const event = events[0];
    expect(event.name).toEqual('gen_ai.assistant.message');
    expect((event as any).data['content']).toEqual('Agent task output result');
    expect((event as any).data['role']).toEqual('assistant');
    expect(event.attributes!['gen_ai.system']).toEqual('crewai');
    expect(event.attributes!['original_attribute']).toEqual('gen_ai.agent.actual_output');
    expect(event.timestamp).toEqual([1234567899, 0]); // endTime
  });

  /**
   * Test extractOpenlitSpanEventAttributes with agent human input attribute
   */
  it('testExtractOpenlitAgentHumanInput', () => {
    const attributes = { 'gen_ai.agent.human_input': 'Human input to the agent', 'gen_ai.system': 'crewai' };

    const span = createMockSpan(attributes);

    const events = lloHandler['extractOpenlitSpanEventAttributes'](span, attributes);

    expect(events.length).toEqual(1);
    const event = events[0];
    expect(event.name).toEqual('gen_ai.user.message');
    expect((event as any).data['content']).toEqual('Human input to the agent');
    expect((event as any).data['role']).toEqual('user');
    expect(event.attributes!['gen_ai.system']).toEqual('crewai');
    expect(event.attributes!['original_attribute']).toEqual('gen_ai.agent.human_input');
    expect(event.timestamp).toEqual([1234567890, 0]); // startTime
  });

  /**
   * Test extractTraceloopEvents with CrewAI specific attributes
   */
  it('testExtractTraceloopCrewOutputs', () => {
    const attributes = {
      'crewai.crew.tasks_output': "[TaskOutput(description='Task description', output='Task result')]",
      'crewai.crew.result': 'Final crew execution result',
      'traceloop.entity.name': 'crewai',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractTraceloopEvents'](span, attributes);

    expect(events.length).toEqual(2);

    // Get a map of original attributes to their content
    const eventsByAttr: { [key: string]: api.Event } = Object.fromEntries(
      events.map(event => [event.attributes!['original_attribute'], event])
    );

    // Check the tasks output event
    expect(eventsByAttr['crewai.crew.tasks_output']).toBeDefined();
    const tasksEvent = eventsByAttr['crewai.crew.tasks_output'];
    expect(tasksEvent.name).toEqual('gen_ai.assistant.message');
    expect((tasksEvent.data as any)['content']).toEqual(
      "[TaskOutput(description='Task description', output='Task result')]"
    );
    expect((tasksEvent.data as any)['role']).toEqual('assistant');
    expect(tasksEvent.attributes!['gen_ai.system']).toEqual('crewai');
    expect(tasksEvent.timestamp).toEqual([1234567899, 0]); // endTime

    // Check the result event
    expect(eventsByAttr['crewai.crew.result']).toBeDefined();
    const resultEvent = eventsByAttr['crewai.crew.result'];
    expect(resultEvent.name).toEqual('gen_ai.assistant.message');
    expect((resultEvent.data as any)['content']).toEqual('Final crew execution result');
    expect((resultEvent.data as any)['role']).toEqual('assistant');
    expect(resultEvent.attributes!['gen_ai.system']).toEqual('crewai');
    expect(resultEvent.timestamp).toEqual([1234567899, 0]); // endTime
  });

  /**
   * Test extractTraceloopEvents with CrewAI specific attributes when gen_ai.system is available
   */
  it('testExtractTraceloopCrewOutputsWithGenAiSystem', () => {
    const attributes = {
      'crewai.crew.tasks_output': "[TaskOutput(description='Task description', output='Task result')]",
      'crewai.crew.result': 'Final crew execution result',
      'traceloop.entity.name': 'oldvalue',
      'gen_ai.system': 'crewai-agent',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractTraceloopEvents'](span, attributes);

    expect(events.length).toEqual(2);

    // Get a map of original attributes to their content
    const eventsByAttr: { [key: string]: api.Event } = Object.fromEntries(
      events.map(event => [event.attributes!['original_attribute'], event])
    );

    // Check the tasks output event
    expect(eventsByAttr['crewai.crew.tasks_output']).toBeDefined();
    const tasksEvent = eventsByAttr['crewai.crew.tasks_output'];
    expect(tasksEvent.name).toEqual('gen_ai.assistant.message');
    // Should use gen_ai.system attribute instead of traceloop.entity.name
    expect(tasksEvent.attributes!['gen_ai.system']).toEqual('crewai-agent');

    // Check the result event
    expect(eventsByAttr['crewai.crew.result']).toBeDefined();
    const resultEvent = eventsByAttr['crewai.crew.result'];
    expect(resultEvent.name).toEqual('gen_ai.assistant.message');
    // Should use gen_ai.system attribute instead of traceloop.entity.name
    expect(resultEvent.attributes!['gen_ai.system']).toEqual('crewai-agent');
  });

  /*
   * Test that traceloop.entity.input and traceloop.entity.output still use traceloop.entity.name
   * even when gen_ai.system is available
   */
  it('testExtractTraceloopEntityWithGenAiSystem', () => {
    const attributes = {
      'traceloop.entity.input': 'input data',
      'traceloop.entity.output': 'output data',
      'traceloop.entity.name': 'my_entity',
      'gen_ai.system': 'should-not-be-used',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    const events = lloHandler['extractTraceloopEvents'](span, attributes);

    expect(events.length).toEqual(2);

    // Get a map of original attributes to their content
    const eventsByAttr: { [key: string]: api.Event } = Object.fromEntries(
      events.map(event => [event.attributes!['original_attribute'], event])
    );

    // Regular traceloop entity attributes should still use traceloop.entity.name
    const inputEvent = eventsByAttr['traceloop.entity.input'];
    expect(inputEvent.name).toEqual('gen_ai.my_entity.message');
    expect(inputEvent.attributes!['gen_ai.system']).toEqual('my_entity');

    const outputEvent = eventsByAttr['traceloop.entity.output'];
    expect(outputEvent.name).toEqual('gen_ai.my_entity.message');
    expect(outputEvent.attributes!['gen_ai.system']).toEqual('my_entity');
  });

  /**
   * Test emitLloAttributes
   */
  it('testEmitLloAttributes', () => {
    const attributes = {
      'gen_ai.prompt.0.content': 'prompt content',
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.completion.0.content': 'completion content',
      'gen_ai.completion.0.role': 'assistant',
      'traceloop.entity.input': 'traceloop input',
      'traceloop.entity.name': 'entity_name',
      'gen_ai.system': 'openai',
      'gen_ai.agent.actual_output': 'agent output',
      'crewai.crew.tasks_output': 'tasks output',
      'crewai.crew.result': 'crew result',
    };

    const span = createMockSpan(attributes);
    span.endTime = [1234567899, 0];

    // Create mocks with name attribute properly set
    const promptEvent: api.Event = {
      name: 'gen_ai.user.message',
    };
    const completionEvent: api.Event = {
      name: 'gen_ai.assistant.message',
    };
    const traceloopEvent: api.Event = { name: 'gen_ai.entity.message' };
    const openlitEvent: api.Event = { name: 'gen_ai.langchain.message' };
    const openinferenceEvent: api.Event = { name: 'gen_ai.anthropic.message' };

    const lloHandlerExtractGenAiPromptEvents = sinon
      .stub(lloHandler, <any>'extractGenAiPromptEvents')
      .callsFake((span, attributes, eventTimestamp) => [promptEvent]);
    const lloHandlerExtractGenAiCompletionEvents = sinon
      .stub(lloHandler, <any>'extractGenAiCompletionEvents')
      .callsFake((span, attributes, eventTimestamp) => [completionEvent]);
    const lloHandlerExtractTraceloopEvents = sinon
      .stub(lloHandler, <any>'extractTraceloopEvents')
      .callsFake((span, attributes, eventTimestamp) => [traceloopEvent]);
    const lloHandlerExtractOpenlitSpanEventAttributes = sinon
      .stub(lloHandler, <any>'extractOpenlitSpanEventAttributes')
      .callsFake((span, attributes, eventTimestamp) => [openlitEvent]);
    const lloHandlerExtractOpeninferenceAttributes = sinon
      .stub(lloHandler, <any>'extractOpeninferenceAttributes')
      .callsFake((span, attributes, eventTimestamp) => [openinferenceEvent]);

    const eventLoggerMockEmit = sinon.stub(eventLoggerMock, 'emit').callsFake((event: api.Event) => {});

    lloHandler['emitLloAttributes'](span, attributes);

    const promptSpan: ReadableSpan = lloHandlerExtractGenAiPromptEvents.getCall(0).args[0];
    const promptAttributes: Attributes = lloHandlerExtractGenAiPromptEvents.getCall(0).args[1];
    const promptEventTimestamp: Attributes = lloHandlerExtractGenAiPromptEvents.getCall(0).args[2];
    expect(promptSpan).toBe(span);
    expect(promptAttributes).toBe(attributes);
    expect(promptEventTimestamp).toBeUndefined();

    const completionSpan: ReadableSpan = lloHandlerExtractGenAiCompletionEvents.getCall(0).args[0];
    const completionAttributes: Attributes = lloHandlerExtractGenAiCompletionEvents.getCall(0).args[1];
    const completionEventTimestamp: Attributes = lloHandlerExtractGenAiCompletionEvents.getCall(0).args[2];
    expect(completionSpan).toBe(span);
    expect(completionAttributes).toBe(attributes);
    expect(completionEventTimestamp).toBeUndefined();

    const traceloopSpan: ReadableSpan = lloHandlerExtractTraceloopEvents.getCall(0).args[0];
    const traceloopAttributes: Attributes = lloHandlerExtractTraceloopEvents.getCall(0).args[1];
    const traceloopEventTimestamp: Attributes = lloHandlerExtractTraceloopEvents.getCall(0).args[2];
    expect(traceloopSpan).toBe(span);
    expect(traceloopAttributes).toBe(attributes);
    expect(traceloopEventTimestamp).toBeUndefined();

    const openlitSpan: ReadableSpan = lloHandlerExtractOpenlitSpanEventAttributes.getCall(0).args[0];
    const openlitAttributes: Attributes = lloHandlerExtractOpenlitSpanEventAttributes.getCall(0).args[1];
    const openlitEventTimestamp: Attributes = lloHandlerExtractOpenlitSpanEventAttributes.getCall(0).args[2];
    expect(openlitSpan).toBe(span);
    expect(openlitAttributes).toBe(attributes);
    expect(openlitEventTimestamp).toBeUndefined();

    const openinferenceSpan: ReadableSpan = lloHandlerExtractOpeninferenceAttributes.getCall(0).args[0];
    const openinferenceAttributes: Attributes = lloHandlerExtractOpeninferenceAttributes.getCall(0).args[1];
    const openinferenceEventTimestamp: Attributes = lloHandlerExtractOpeninferenceAttributes.getCall(0).args[2];
    expect(openinferenceSpan).toBe(span);
    expect(openinferenceAttributes).toBe(attributes);
    expect(openinferenceEventTimestamp).toBeUndefined();

    const eventLoggerPromptCallArg = eventLoggerMockEmit.getCall(0).args[0];
    const eventLoggerCompletionCallArg = eventLoggerMockEmit.getCall(1).args[0];
    const eventLoggerTraceloopCallArg = eventLoggerMockEmit.getCall(2).args[0];
    const eventLoggerOpenlitCallArg = eventLoggerMockEmit.getCall(3).args[0];
    const eventLoggerOpeninferenceCallArg = eventLoggerMockEmit.getCall(4).args[0];

    expect(eventLoggerPromptCallArg).toBe(promptEvent);
    expect(eventLoggerCompletionCallArg).toBe(completionEvent);
    expect(eventLoggerTraceloopCallArg).toBe(traceloopEvent);
    expect(eventLoggerOpenlitCallArg).toBe(openlitEvent);
    expect(eventLoggerOpeninferenceCallArg).toBe(openinferenceEvent);
  });

  /**
   * Test processSpans
   */
  it('testProcessSpans', () => {
    const attributes: Attributes = { 'gen_ai.prompt.0.content': 'prompt content', 'normal.attribute': 'normal value' };

    const span = createMockSpan(attributes);

    const filteredAttributes: Attributes = { 'normal.attribute': 'normal value' };

    const lloHandlerEmitLloAttributes = sinon.stub(lloHandler, <any>'emitLloAttributes');
    const lloHandlerFilterAttributes = sinon
      .stub(lloHandler, <any>'filterAttributes')
      .callsFake(attributes => filteredAttributes);

    const result = lloHandler.processSpans([span]);

    const emitLloAttributesCallArg0 = lloHandlerEmitLloAttributes.getCall(0).args[0];
    const emitLloAttributesCallArg1 = lloHandlerEmitLloAttributes.getCall(0).args[1];
    const emitLloAttributesCallArg2 = lloHandlerEmitLloAttributes.getCall(0).args[2];
    expect(emitLloAttributesCallArg0).toBe(span);
    expect(emitLloAttributesCallArg1).toBe(attributes);
    expect(emitLloAttributesCallArg2).toBe(undefined);

    const filterAttributesCallArg0 = lloHandlerFilterAttributes.getCall(0).args[0];
    expect(filterAttributesCallArg0).toBe(attributes);

    expect(result.length).toEqual(1);
    expect(result[0]).toEqual(span);
    // Access the attributes property that was set by the processSpans method
    expect(result[0].attributes).toEqual(filteredAttributes);
  });

  /**
   * Test processSpansEvents
   */
  it('testProcessSpanEvents', () => {
    const span = createMockSpan({});
    span.events = [
      {
        name: 'testEvent0',
        time: [0, 1],
        attributes: {
          'traceloop.entity.input': 'testInput',
          'traceloop.entity.output': 'testOutput',
          'traceloop.entity.name': 'testName',
        },
      },
    ];

    lloHandler.processSpanEvents(span);
    expect(span.events[0].attributes).toEqual({ 'traceloop.entity.name': 'testName' });
  });
});
