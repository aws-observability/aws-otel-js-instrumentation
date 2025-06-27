// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LLOHandlerTestBase } from './llo-handler.base.test';
import { expect } from 'expect';
import * as sinon from 'sinon';
import { Event } from '@opentelemetry/api-events';
import { TimedEvent } from '@opentelemetry/sdk-trace-base';
import { InstrumentationScope } from '@opentelemetry/core';
import { OTEL_SPAN_KEY } from '../src/llo-handler';
import { Attributes, HrTime, trace } from '@opentelemetry/api';

/**
 * Test event emission and formatting functionality.
 */
describe('TestLLOHandlerEvents', () => {
  let testBase: LLOHandlerTestBase;

  beforeEach(() => {
    testBase = new LLOHandlerTestBase();
  });

  afterEach(() => {
    sinon.restore();
  });

  /**
   * Verify emitLloAttributes creates a single consolidated event with input/output message groups
   * containing all LLO content from various frameworks.
   */
  it('should emit consolidated event with input/output message groups', () => {
    // Create attributes simulating content from multiple frameworks
    const attributes = {
      'gen_ai.prompt.0.content': 'prompt content',
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.completion.0.content': 'completion content',
      'gen_ai.completion.0.role': 'assistant',
      'traceloop.entity.input': 'traceloop input',
      'traceloop.entity.name': 'entity_name',
      'gen_ai.agent.actual_output': 'agent output',
      'crewai.crew.tasks_output': 'tasks output',
      'crewai.crew.result': 'crew result',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;

    expect(emittedEvent.name).toBe('test.scope');
    expect(emittedEvent.timestamp).toEqual(span.endTime);
    expect(emittedEvent.context?.getValue(OTEL_SPAN_KEY)).toBe(span);
    expect(trace.getSpanContext(emittedEvent.context!)).toBe(span.spanContext());

    expect(emittedEvent.data).toBeDefined();

    const eventBody = emittedEvent.data as any;
    expect(eventBody.input).toBeDefined();
    expect(eventBody.output).toBeDefined();
    expect(eventBody.input.messages).toBeDefined();
    expect(eventBody.output.messages).toBeDefined();

    const inputMessages = eventBody.input.messages;
    expect(inputMessages.length).toBe(2);

    const userPrompt = inputMessages.find((msg: any) => msg.content === 'prompt content');
    expect(userPrompt).toBeDefined();
    expect(userPrompt.role).toBe('user');

    const traceloopInput = inputMessages.find((msg: any) => msg.content === 'traceloop input');
    expect(traceloopInput).toBeDefined();
    expect(traceloopInput.role).toBe('user');

    const outputMessages = eventBody.output.messages;
    expect(outputMessages.length).toBeGreaterThanOrEqual(3);

    const completion = outputMessages.find((msg: any) => msg.content === 'completion content');
    expect(completion).toBeDefined();
    expect(completion.role).toBe('assistant');

    const agentOutput = outputMessages.find((msg: any) => msg.content === 'agent output');
    expect(agentOutput).toBeDefined();
    expect(agentOutput.role).toBe('assistant');
  });

  /**
   * Verify a single span containing LLO attributes from multiple frameworks
   * (Traceloop, OpenLit, OpenInference, CrewAI) generates one consolidated event.
   */
  it('should emit consolidated event from multiple frameworks', () => {
    const attributes = {
      'gen_ai.prompt.0.content': 'Tell me about AI',
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.completion.0.content': 'AI is a field of computer science...',
      'gen_ai.completion.0.role': 'assistant',
      'traceloop.entity.input': 'What is machine learning?',
      'traceloop.entity.output': 'Machine learning is a subset of AI...',
      'gen_ai.prompt': 'Explain neural networks',
      'gen_ai.completion': 'Neural networks are computing systems...',
      'input.value': 'How do transformers work?',
      'output.value': 'Transformers are a type of neural network architecture...',
      'crewai.crew.result': 'Task completed successfully',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.multi.framework', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;

    expect(emittedEvent.name).toBe('test.multi.framework');
    expect(emittedEvent.timestamp).toEqual(span.endTime);

    const eventBody = emittedEvent.data as any;
    expect(eventBody.input).toBeDefined();
    expect(eventBody.output).toBeDefined();

    const inputMessages = eventBody.input.messages;
    const inputContents = inputMessages.map((msg: any) => msg.content);
    expect(inputContents).toContain('Tell me about AI');
    expect(inputContents).toContain('What is machine learning?');
    expect(inputContents).toContain('Explain neural networks');
    expect(inputContents).toContain('How do transformers work?');

    // Verify output messages from all frameworks
    const outputMessages = eventBody.output.messages;
    const outputContents = outputMessages.map((msg: any) => msg.content);
    expect(outputContents).toContain('AI is a field of computer science...');
    expect(outputContents).toContain('Machine learning is a subset of AI...');
    expect(outputContents).toContain('Neural networks are computing systems...');
    expect(outputContents).toContain('Transformers are a type of neural network architecture...');
    expect(outputContents).toContain('Task completed successfully');

    inputMessages.forEach((msg: any) => {
      expect(['user', 'system']).toContain(msg.role);
    });
    outputMessages.forEach((msg: any) => {
      expect(msg.role).toBe('assistant');
    });
  });

  /**
   * Verify emitLloAttributes does not emit events when span contains only non-LLO attributes.
   */
  it('should not emit event when span contains only non-LLO attributes', () => {
    const attributes = {
      'normal.attribute': 'value',
      'another.attribute': 123,
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.notCalled((testBase.eventLoggerMock as any).emit);
  });

  /**
   * Verify event generation correctly separates mixed input (system/user) and output (assistant) messages.
   */
  it('should separate mixed input/output messages correctly', () => {
    const attributes = {
      'gen_ai.prompt.0.content': 'system message',
      'gen_ai.prompt.0.role': 'system',
      'gen_ai.prompt.1.content': 'user message',
      'gen_ai.prompt.1.role': 'user',
      'gen_ai.completion.0.content': 'assistant response',
      'gen_ai.completion.0.role': 'assistant',
      'input.value': 'direct input',
      'output.value': 'direct output',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;

    const eventBody = emittedEvent.data as any;
    expect(eventBody.input).toBeDefined();
    expect(eventBody.output).toBeDefined();

    const inputMessages = eventBody.input.messages;
    expect(inputMessages.length).toBe(3);

    const inputRoles = inputMessages.map((msg: any) => msg.role);
    expect(inputRoles).toContain('system');
    expect(inputRoles).toContain('user');

    const outputMessages = eventBody.output.messages;
    expect(outputMessages.length).toBe(2);

    outputMessages.forEach((msg: any) => {
      expect(msg.role).toBe('assistant');
    });
  });

  /**
   * Verify emitLloAttributes uses provided event timestamp instead of span end time.
   */
  it('should use provided event timestamp instead of span end time', () => {
    const attributes = {
      'gen_ai.prompt': 'test prompt',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    const eventTimestamp: HrTime = [9999999999, 0];

    testBase.lloHandler['emitLloAttributes'](span, attributes, eventTimestamp);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;
    expect(emittedEvent.timestamp).toEqual(eventTimestamp);
  });

  /**
   * Test emitLloAttributes with null attributes - should return early
   */
  it('should handle null attributes in emitLloAttributes', () => {
    const span = testBase.createMockSpan({});
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, null as any);

    sinon.assert.notCalled(testBase.eventLoggerMock.emit as any);
  });

  /**
   * Test role-based routing for non-standard roles
   */
  it('should route non-standard roles based on source', () => {
    const attributes = {
      // Standard roles - should go to their expected places
      'gen_ai.prompt.0.content': 'system prompt',
      'gen_ai.prompt.0.role': 'system',
      'gen_ai.prompt.1.content': 'user prompt',
      'gen_ai.prompt.1.role': 'user',
      'gen_ai.completion.0.content': 'assistant response',
      'gen_ai.completion.0.role': 'assistant',
      // Non-standard roles - should be routed based on source
      'gen_ai.prompt.2.content': 'function prompt',
      'gen_ai.prompt.2.role': 'function',
      'gen_ai.completion.1.content': 'tool completion',
      'gen_ai.completion.1.role': 'tool',
      'gen_ai.prompt.3.content': 'unknown prompt',
      'gen_ai.prompt.3.role': 'custom_role',
      'gen_ai.completion.2.content': 'unknown completion',
      'gen_ai.completion.2.role': 'another_custom',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    // Verify event was emitted
    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;
    const eventBody = emittedEvent.data as any;

    // Check input messages
    const inputMessages = eventBody.input.messages;
    const inputContents = inputMessages.map((msg: any) => msg.content);

    // Standard roles (system, user) should be in input
    expect(inputContents).toContain('system prompt');
    expect(inputContents).toContain('user prompt');

    // Non-standard roles from prompt source should be in input
    expect(inputContents).toContain('function prompt');
    expect(inputContents).toContain('unknown prompt');

    // Check output messages
    const outputMessages = eventBody.output.messages;
    const outputContents = outputMessages.map((msg: any) => msg.content);

    // Standard role (assistant) should be in output
    expect(outputContents).toContain('assistant response');

    // Non-standard roles from completion source should be in output
    expect(outputContents).toContain('tool completion');
    expect(outputContents).toContain('unknown completion');
  });

  /**
   * Test emitLloAttributes when messages list is empty after collection
   */
  it('should not emit event when messages list is empty after collection', () => {
    // Create a span with attributes that would normally match patterns but with empty content
    const attributes = {
      'gen_ai.prompt.0.content': '',
      'gen_ai.prompt.0.role': 'user',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    // Mock collectAllLloMessages to return an empty array
    const collectAllLloMessagesSpy = sinon.stub(testBase.lloHandler as any, 'collectAllLloMessages').returns([]);

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    // Should not emit event when no messages collected
    sinon.assert.notCalled(testBase.eventLoggerMock.emit as any);

    collectAllLloMessagesSpy.restore();
  });

  /**
   * Test event generation when only input messages are present
   */
  it('should test emitLloAttributes with only input messages', () => {
    const attributes = {
      'gen_ai.prompt.0.content': 'system instruction',
      'gen_ai.prompt.0.role': 'system',
      'gen_ai.prompt.1.content': 'user question',
      'gen_ai.prompt.1.role': 'user',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;
    const eventBody = emittedEvent.data as any;

    expect(eventBody.input).toBeDefined();
    expect(eventBody).not.toHaveProperty('output');

    const inputMessages = eventBody.input.messages;
    expect(inputMessages.length).toBe(2);
  });

  /**
   * Test event generation when only output messages are present
   */
  it('should test emitLloAttributes with only output messages', () => {
    const attributes = {
      'gen_ai.completion.0.content': 'assistant response',
      'gen_ai.completion.0.role': 'assistant',
      'output.value': 'another output',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;
    const eventBody = emittedEvent.data as any;

    expect(eventBody).not.toHaveProperty('input');
    expect(eventBody.output).toBeDefined();

    const outputMessages = eventBody.output.messages;
    expect(outputMessages.length).toBe(2);
  });

  /**
   * Test that no event is emitted when event body would be empty
   */
  it('should test emitLloAttributes with empty event body', () => {
    // Create attributes that would result in messages with empty content from collectAllLloMessages
    const attributes: Attributes = {
      'gen_ai.prompt.0.content': '',
      'gen_ai.prompt.0.role': 'user',
    };
    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    // Event should still be emitted as we have a message (even with empty content)
    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
  });

  /**
   * Test groupMessagesByType correctly groups messages with standard roles.
   */
  it('should test groupMessagesByType with standard roles', () => {
    const messages = [
      { role: 'system', content: 'System message', source: 'prompt' },
      { role: 'user', content: 'User message', source: 'prompt' },
      { role: 'assistant', content: 'Assistant message', source: 'completion' },
    ];

    const result = testBase.lloHandler['groupMessagesByType'](messages);

    expect(result.input).toBeDefined();
    expect(result.output).toBeDefined();

    // Check input messages
    expect(result.input.length).toBe(2);
    expect(result.input[0]).toEqual({ role: 'system', content: 'System message' });
    expect(result.input[1]).toEqual({ role: 'user', content: 'User message' });

    // Check output messages
    expect(result.output.length).toBe(1);
    expect(result.output[0]).toEqual({ role: 'assistant', content: 'Assistant message' });
  });

  /**
   * Test groupMessagesByType correctly routes non-standard roles based on source.
   */
  it('should test groupMessagesByType with non standard roles', () => {
    const messages = [
      { role: 'function', content: 'Function call', source: 'prompt' },
      { role: 'tool', content: 'Tool result', source: 'completion' },
      { role: 'custom', content: 'Custom output', source: 'output' },
      { role: 'other', content: 'Other result', source: 'result' },
    ];

    const result = testBase.lloHandler['groupMessagesByType'](messages);

    // Non-standard roles from prompt source go to input
    expect(result.input.length).toBe(1);
    expect(result.input[0]).toEqual({ role: 'function', content: 'Function call' });

    // Non-standard roles from completion/output/result sources go to output
    expect(result.output.length).toBe(3);
    const outputContents = result.output.map(msg => msg.content);
    expect(outputContents).toContain('Tool result');
    expect(outputContents).toContain('Custom output');
    expect(outputContents).toContain('Other result');
  });

  /**
   * Test groupMessagesByType handles empty message list.
   */
  it('should test groupMessagesByType handle empty list', () => {
    const result = testBase.lloHandler['groupMessagesByType']([]);

    expect(result.input).toEqual([]);
    expect(result.output).toEqual([]);
    expect(result.input.length).toBe(0);
    expect(result.output.length).toBe(0);
  });

  /**
   * Test that llm.prompts attribute is properly emitted in the input section.
   */
  it('should handle llm.prompts attribute', () => {
    const llmPromptsContent = "[{'role': 'system', 'content': [{'text': 'You are helpful.', 'type': 'text'}]}]";
    const attributes = {
      'llm.prompts': llmPromptsContent,
      'gen_ai.completion.0.content': 'I understand.',
      'gen_ai.completion.0.role': 'assistant',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;
    const eventBody = emittedEvent.data as any;

    // Check that llm.prompts is in input section
    expect(eventBody.input).toBeDefined();
    expect(eventBody.output).toBeDefined();

    const inputMessages = eventBody.input.messages;
    expect(inputMessages.length).toBe(1);
    expect(inputMessages[0].content).toBe(llmPromptsContent);
    expect(inputMessages[0].role).toBe('user');

    // Check output section has the completion
    const outputMessages = eventBody.output.messages;
    expect(outputMessages.length).toBe(1);
    expect(outputMessages[0].content).toBe('I understand.');
    expect(outputMessages[0].role).toBe('assistant');
  });

  /**
   * Test that LLO attributes from OpenLit-style span events are collected and emitted
   * in a single consolidated event, not as separate events.
   */
  it('should emit a single consolidated event for OpenLit-style span events', () => {
    // This test simulates the OpenLit pattern where prompt and completion are in span events
    // The span processor should collect from both and emit a single event
    const spanAttributes = { 'normal.attribute': 'value' };

    // Create events like OpenLit does
    const promptEventAttrs = { 'gen_ai.prompt': 'Explain quantum computing' };
    const promptEvent: TimedEvent = {
      attributes: promptEventAttrs,
      name: 'prompt_event',
      time: [1234567890, 0],
    };

    const completionEventAttrs = { 'gen_ai.completion': 'Quantum computing is...' };
    const completionEvent: TimedEvent = {
      attributes: completionEventAttrs,
      name: 'completion_event',
      time: [1234567891, 0],
    };

    const span = testBase.createMockSpan(spanAttributes);
    testBase.updateMockSpanKey(span, 'events', [promptEvent, completionEvent]);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', {
      name: 'openlit.otel.tracing',
      version: '1.0.0',
    } as InstrumentationScope);

    // Process the span (this would normally be called by processSpans)
    const allLloAttrs = testBase.lloHandler['collectLloAttributesFromSpan'](span);

    // Emit consolidated event
    testBase.lloHandler['emitLloAttributes'](span, allLloAttrs);

    // Verify single event was emitted with both input and output
    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;
    const eventBody = emittedEvent.data as any;

    // Both input and output should be in the same event
    expect(eventBody.input).toBeDefined();
    expect(eventBody.output).toBeDefined();

    // Check input section
    const inputMessages = eventBody.input.messages;
    expect(inputMessages.length).toBe(1);
    expect(inputMessages[0].content).toBe('Explain quantum computing');
    expect(inputMessages[0].role).toBe('user');

    // Check output section
    const outputMessages = eventBody.output.messages;
    expect(outputMessages.length).toBe(1);
    expect(outputMessages[0].content).toBe('Quantum computing is...');
    expect(outputMessages[0].role).toBe('assistant');
  });

  /**
   * Verify session.id attribute from span is copied to event attributes when present.
   */
  it('emitLloAttributes should copy session.id to event attributes when present', () => {
    const attributes = {
      'session.id': 'test-session-123',
      'gen_ai.prompt': 'Hello, AI',
      'gen_ai.completion': 'Hello! How can I help you?',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;

    // Verify session.id was copied to event attributes
    expect(emittedEvent.attributes).toBeDefined();
    expect(emittedEvent.attributes?.['session.id']).toBe('test-session-123');

    // Verify event body still contains LLO data
    const eventBody = emittedEvent.data as any;
    expect(eventBody.input).toBeDefined();
    expect(eventBody.output).toBeDefined();
  });

  /**
   * Verify event attributes do not contain session.id when not present in span attributes.
   */
  it('emitLloAttributes should not include session.id in event attributes when not present', () => {
    const attributes = {
      'gen_ai.prompt': 'Hello, AI',
      'gen_ai.completion': 'Hello! How can I help you?',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;

    // Verify session.id is not in event attributes (because the event doesn't have attributes)
    expect(emittedEvent.attributes).toBeUndefined();
    expect(emittedEvent).not.toHaveProperty('attributes');
  });

  /**
   * Verify only session.id is copied from span attributes when mixed with other attributes.
   */
  it('emitLloAttributes should only copy session.id when mixed with other attributes', () => {
    const attributes = {
      'session.id': 'session-456',
      'user.id': 'user-789',
      'gen_ai.prompt': "What's the weather?",
      'gen_ai.completion': "I can't check the weather.",
      'other.attribute': 'some-value',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey(span, 'instrumentationLibrary', { name: 'test.scope', version: '1.0.0' });

    testBase.lloHandler['emitLloAttributes'](span, attributes);

    sinon.assert.calledOnce(testBase.eventLoggerMock.emit as any);
    const emittedEvent = (testBase.eventLoggerMock.emit as any).getCall(0).args[0] as Event;

    // Verify only session.id was copied to event attributes (plus event.name from Event class)
    expect(emittedEvent.attributes).toBeDefined();
    expect(emittedEvent.attributes?.['session.id']).toBe('session-456');
    // Verify other span attributes were not copied
    expect(emittedEvent.attributes).not.toHaveProperty('user.id');
    expect(emittedEvent.attributes).not.toHaveProperty('other.attribute');
    expect(emittedEvent.attributes).not.toHaveProperty('gen_ai.prompt');
    expect(emittedEvent.attributes).not.toHaveProperty('gen_ai.completion');
  });
});
