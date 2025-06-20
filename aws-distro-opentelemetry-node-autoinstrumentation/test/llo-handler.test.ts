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
    // TODO: Test other frameworks

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
    const traceloopEvent: api.Event = { name: 'gen_ai.entity.message' };

    const lloHandlerExtractTraceloopEvents = sinon
      .stub(lloHandler, <any>'extractTraceloopEvents')
      .callsFake((span, attributes, eventTimestamp) => [traceloopEvent]);

    const eventLoggerMockEmit = sinon.stub(eventLoggerMock, 'emit').callsFake((event: api.Event) => {});

    lloHandler['emitLloAttributes'](span, attributes);

    const traceloopSpan: ReadableSpan = lloHandlerExtractTraceloopEvents.getCall(0).args[0];
    const traceloopAttributes: Attributes = lloHandlerExtractTraceloopEvents.getCall(0).args[1];
    const traceloopEventTimestamp: Attributes = lloHandlerExtractTraceloopEvents.getCall(0).args[2];
    expect(traceloopSpan).toBe(span);
    expect(traceloopAttributes).toBe(attributes);
    expect(traceloopEventTimestamp).toBeUndefined();

    const eventLoggerTraceloopCallArg = eventLoggerMockEmit.getCall(0).args[0];
    expect(eventLoggerTraceloopCallArg).toBe(traceloopEvent);
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
   * Test processSpanEvents
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
