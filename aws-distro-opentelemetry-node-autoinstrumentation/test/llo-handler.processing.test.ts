// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes } from '@opentelemetry/api';
import { TimedEvent } from '@opentelemetry/sdk-trace-base';
import expect from 'expect';
import * as sinon from 'sinon';
import { LLOHandlerTestBase } from './llo-handler.base.test';
import { InstrumentationLibrary } from '@opentelemetry/core';

/**
 * Test span processing and attribute filtering functionality.
 */
describe('TestLLOHandlerProcessing', () => {
  let testBase: LLOHandlerTestBase;

  beforeEach(() => {
    testBase = new LLOHandlerTestBase();
  });

  afterEach(() => {
    sinon.restore();
  });

  /**
   * Verify filterAttributes removes LLO content attributes while preserving role attributes
   * and other non-LLO attributes.
   */
  it('should test filterAttributes', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.0.content': 'test content',
      'gen_ai.prompt.0.role': 'user',
      'normal.attribute': 'value',
      'another.normal.attribute': 123,
    };

    const filtered = testBase.lloHandler['filterAttributes'](attributes);

    expect(filtered).not.toHaveProperty('gen_ai.prompt.0.content');
    expect(filtered['gen_ai.prompt.0.role']).toBeDefined();
    expect(filtered['normal.attribute']).toBeDefined();
    expect(filtered['another.normal.attribute']).toBeDefined();
  });

  /**
   * Verify filterAttributes returns empty attributes when given empty attributes.
   */
  it('should test filterAttributes with empty attributes', () => {
    const result = testBase.lloHandler['filterAttributes']({});
    expect(result).toEqual({});
  });

  /**
   * Verify filterAttributes returns original attributes when no LLO attributes are present.
   */
  it('should test filterAttributes does no handling', () => {
    const attributes = { 'normal.attr': 'value' };
    const result = testBase.lloHandler['filterAttributes'](attributes);
    expect(result).toStrictEqual(attributes);
  });

  /**
   * Test filterAttributes when there are no LLO attributes - should return original
   */
  it('should test filterAttributes no llo attrs', () => {
    const attributes = {
      'normal.attr1': 'value1',
      'normal.attr2': 'value2',
      'other.attribute': 'value', // This is not an LLO attribute
    };

    const result = testBase.lloHandler['filterAttributes'](attributes);

    // Should return the same attributes object when no LLO attrs present
    expect(result).toStrictEqual(attributes);
    expect(result).toEqual(attributes);
  });

  /**
   * Verify processSpans extracts LLO attributes, emits events, filters attributes,
   * and processes span events correctly.
   */
  it('should test processSpans', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.0.content': 'prompt content',
      'normal.attribute': 'normal value',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<TimedEvent[]>(span, 'events', []);

    const emitStub = sinon.stub(testBase.lloHandler as any, 'emitLloAttributes');
    const filterStub = sinon
      .stub(testBase.lloHandler as any, 'filterAttributes')
      .returns({ 'normal.attribute': 'normal value' });

    const result = testBase.lloHandler.processSpans([span]);

    // Now it's called with only the LLO attributes
    const expectedLloAttrs = { 'gen_ai.prompt.0.content': 'prompt content' };
    expect(emitStub.calledOnceWith(span, expectedLloAttrs)).toBeTruthy();
    expect(filterStub.calledOnceWith(attributes)).toBeTruthy();

    expect(result.length).toBe(1);
    expect(result[0]).toBe(span);
    expect(result[0].attributes).toEqual({ 'normal.attribute': 'normal value' });
  });

  /**
   * Verify processSpans correctly handles spans with empty attributes.
   */
  it('should test processSpans with empty attributes', () => {
    const span = testBase.createMockSpan({});
    testBase.updateMockSpanKey<TimedEvent[]>(span, 'events', []);

    const result = testBase.lloHandler.processSpans([span]);

    expect(result.length).toBe(1);
    expect(result[0].attributes).toEqual({});
  });

  /**
   * Verify filterSpanEvents filters LLO attributes from span events correctly.
   */
  it('should test filterSpanEvents', () => {
    const eventAttributes: Attributes = {
      'gen_ai.prompt': 'event prompt',
      'normal.attribute': 'keep this',
    };

    const event: TimedEvent = {
      name: 'test_event',
      attributes: eventAttributes,
      time: [1234567890, 0],
    };

    const span = testBase.createMockSpan({});
    testBase.updateMockSpanKey<TimedEvent[]>(span, 'events', [event]);
    testBase.updateMockSpanKey<InstrumentationLibrary>(span, 'instrumentationLibrary', {
      name: 'test.scope',
      version: '1.0.0',
    });

    testBase.lloHandler['filterSpanEvents'](span);

    const spanEvents = span.events;
    const updatedEvent = spanEvents[0];
    expect(updatedEvent.attributes!['normal.attribute']).toBeDefined();
    expect(updatedEvent.attributes).not.toHaveProperty('gen_ai.prompt');
  });

  /**
   * Verify filterSpanEvents handles spans with no events gracefully.
   */
  it('should test filterSpanEvents no events', () => {
    const span = testBase.createMockSpan({});
    testBase.updateMockSpanKey<TimedEvent[]>(span, 'events', []);

    testBase.lloHandler['filterSpanEvents'](span);

    expect(span.events).toEqual([]);
  });

  /**
   * Test filterSpanEvents when event has no attributes
   */
  it('should test filterSpanEvents no attributes', () => {
    const event: TimedEvent = {
      name: 'test_event',
      attributes: {},
      time: [1234567890, 0],
    };

    const span = testBase.createMockSpan({});
    testBase.updateMockSpanKey<TimedEvent[]>(span, 'events', [event]);

    testBase.lloHandler['filterSpanEvents'](span);

    // Should handle gracefully and keep the original event
    const spanEvents = span.events;
    expect(spanEvents.length).toBe(1);
    expect(spanEvents[0]).toBe(event);
  });

  /**
   * Verify processSpans collects LLO attributes from both span attributes and events,
   * then emits a single consolidated event.
   */
  it('should test processSpans consolidated event emission', () => {
    // Span attributes with prompt
    const spanAttributes: Attributes = {
      'gen_ai.prompt': 'What is quantum computing?',
      'normal.attribute': 'keep this',
    };

    // Event attributes with completion
    const eventAttributes: Attributes = {
      'gen_ai.completion': 'Quantum computing is...',
      'other.attribute': 'also keep this',
    };

    const event: TimedEvent = {
      name: 'gen_ai.content.completion',
      attributes: eventAttributes,
      time: [1234567890, 0],
    };

    const span = testBase.createMockSpan(spanAttributes);
    testBase.updateMockSpanKey<TimedEvent[]>(span, 'events', [event]);
    testBase.updateMockSpanKey<InstrumentationLibrary>(span, 'instrumentationLibrary', {
      name: 'openlit.otel.tracing',
      version: '1.0.0',
    });

    const emitStub = sinon.stub(testBase.lloHandler as any, 'emitLloAttributes');

    testBase.lloHandler.processSpans([span]);

    // Should emit once with combined attributes
    expect(emitStub.calledOnce).toBeTruthy();
    const [emittedSpan, emittedAttributes] = emitStub.firstCall.args;

    expect(emittedSpan).toBe(span);
    expect(emittedAttributes['gen_ai.prompt']).toBe('What is quantum computing?');
    expect(emittedAttributes['gen_ai.completion']).toBe('Quantum computing is...');

    // Verify span attributes are filtered
    expect(span.attributes).not.toHaveProperty('gen_ai.prompt');
    expect(span.attributes['normal.attribute']).toBe('keep this');

    // Verify event attributes are filtered
    const updatedEvent = span.events[0];
    expect(updatedEvent.attributes).not.toHaveProperty('gen_ai.completion');
    expect(updatedEvent.attributes!['other.attribute']).toBe('also keep this');
  });

  /**
   * Verify processSpans handles multiple events correctly, collecting all LLO attributes
   * into a single consolidated event.
   */
  it('should test processSpans multiple events consolidated', () => {
    const spanAttributes: Attributes = { 'normal.attribute': 'keep this' };

    // First event with prompt
    const event1Attrs: Attributes = { 'gen_ai.prompt': 'First question' };
    const event1: TimedEvent = {
      name: 'gen_ai.content.prompt',
      attributes: event1Attrs,
      time: [1234567890, 0],
    };

    // Second event with completion
    const event2Attrs: Attributes = { 'gen_ai.completion': 'First answer' };
    const event2: TimedEvent = {
      name: 'gen_ai.content.completion',
      attributes: event2Attrs,
      time: [1234567891, 0],
    };

    const span = testBase.createMockSpan(spanAttributes);
    testBase.updateMockSpanKey<TimedEvent[]>(span, 'events', [event1, event2]);
    testBase.updateMockSpanKey<InstrumentationLibrary>(span, 'instrumentationLibrary', {
      name: 'openlit.otel.tracing',
      version: '1.0.0',
    });

    const emitStub = sinon.stub(testBase.lloHandler as any, 'emitLloAttributes');

    testBase.lloHandler.processSpans([span]);

    // Should emit once with attributes from both events
    expect(emitStub.calledOnce).toBeTruthy();
    const emittedAttributes = emitStub.firstCall.args[1];

    expect(emittedAttributes['gen_ai.prompt']).toBe('First question');
    expect(emittedAttributes['gen_ai.completion']).toBe('First answer');
  });
});
