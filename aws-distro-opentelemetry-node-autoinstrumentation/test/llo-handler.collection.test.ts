// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, HrTime } from '@opentelemetry/api';
import expect from 'expect';
import { LLOHandlerTestBase } from './llo-handler.base.test';
import * as sinon from 'sinon';

/**
 * Test message collection from various frameworks.
 */
describe('TestLLOHandlerCollection', () => {
  let testBase: LLOHandlerTestBase;

  beforeEach(() => {
    testBase = new LLOHandlerTestBase();
  });

  afterEach(() => {
    sinon.restore();
  });

  /**
   * Verify indexed prompt messages with system role are collected with correct content, role, and source.
   */
  it('should collect gen_ai_prompt_messages with system role', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.0.content': 'system instruction',
      'gen_ai.prompt.0.role': 'system',
    };

    const span = testBase.createMockSpan(attributes);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('system instruction');
    expect(message.role).toBe('system');
    expect(message.source).toBe('prompt');
  });

  /**
   * Verify indexed prompt messages with user role are collected with correct content, role, and source.
   */
  it('should collect gen_ai_prompt_messages with user role', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.0.content': 'user question',
      'gen_ai.prompt.0.role': 'user',
    };

    const span = testBase.createMockSpan(attributes);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('user question');
    expect(message.role).toBe('user');
    expect(message.source).toBe('prompt');
  });

  /**
   * Verify indexed prompt messages with assistant role are collected with correct content, role, and source.
   */
  it('should collect gen_ai_prompt_messages with assistant role', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.1.content': 'assistant response',
      'gen_ai.prompt.1.role': 'assistant',
    };

    const span = testBase.createMockSpan(attributes);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('assistant response');
    expect(message.role).toBe('assistant');
    expect(message.source).toBe('prompt');
  });

  /**
   * Verify indexed prompt messages with non-standard 'function' role are collected correctly.
   */
  it('should collect gen_ai_prompt_messages with function role', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.2.content': 'function data',
      'gen_ai.prompt.2.role': 'function',
    };

    const span = testBase.createMockSpan(attributes);
    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('function data');
    expect(message.role).toBe('function');
    expect(message.source).toBe('prompt');
  });

  /**
   * Verify indexed prompt messages with unknown role are collected with the role preserved.
   */
  it('should collect gen_ai_prompt_messages with unknown role', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.3.content': 'unknown type content',
      'gen_ai.prompt.3.role': 'unknown',
    };

    const span = testBase.createMockSpan(attributes);
    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('unknown type content');
    expect(message.role).toBe('unknown');
    expect(message.source).toBe('prompt');
  });

  /**
   * Verify indexed completion messages with assistant role are collected with source='completion'.
   */
  it('should collect gen_ai_completion_messages with assistant role', () => {
    const attributes: Attributes = {
      'gen_ai.completion.0.content': 'assistant completion',
      'gen_ai.completion.0.role': 'assistant',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('assistant completion');
    expect(message.role).toBe('assistant');
    expect(message.source).toBe('completion');
  });

  /**
   * Verify indexed completion messages with custom roles are collected with source='completion'.
   */
  it('should collect gen_ai_completion_messages with other role', () => {
    const attributes: Attributes = {
      'gen_ai.completion.1.content': 'other completion',
      'gen_ai.completion.1.role': 'other',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('other completion');
    expect(message.role).toBe('other');
    expect(message.source).toBe('completion');
  });

  /**
   * Verify collectAllLloMessages returns empty list when attributes are empty.
   */
  it('should return empty list for collectAllLloMessages with empty attributes', () => {
    const span = testBase.createMockSpan({});

    const messages = testBase.lloHandler['collectAllLloMessages'](span, {});

    expect(messages).toEqual([]);
    expect(messages.length).toBe(0);
  });

  /**
   * Verify collectIndexedMessages returns empty list when attributes are None.
   */
  it('should return empty list for collectIndexedMessages with empty attributes', () => {
    const messages = testBase.lloHandler['collectIndexedMessages']({});

    expect(messages).toEqual([]);
    expect(messages.length).toBe(0);
  });

  /**
   * Verify indexed messages use default roles when role attributes are missing.
   */
  it('should use default roles when role attributes are missing', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.0.content': 'prompt without role',
      'gen_ai.completion.0.content': 'completion without role',
    };

    const span = testBase.createMockSpan(attributes);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(2);

    const promptMsg = messages.find(m => m.content === 'prompt without role');
    expect(promptMsg).toBeDefined();
    expect(promptMsg!.role).toBe('unknown');
    expect(promptMsg!.source).toBe('prompt');

    const completionMsg = messages.find(m => m.content === 'completion without role');
    expect(completionMsg).toBeDefined();
    expect(completionMsg!.role).toBe('unknown');
    expect(completionMsg!.source).toBe('completion');
  });

  /**
   * Test that indexed messages are sorted correctly even with out-of-order indices
   */
  it('should sort indexed messages correctly witwith out-of-order indices', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.5.content': 'fifth prompt',
      'gen_ai.prompt.5.role': 'user',
      'gen_ai.prompt.1.content': 'first prompt',
      'gen_ai.prompt.1.role': 'system',
      'gen_ai.prompt.3.content': 'third prompt',
      'gen_ai.prompt.3.role': 'user',
      'llm.input_messages.10.message.content': 'tenth message',
      'llm.input_messages.10.message.role': 'assistant',
      'llm.input_messages.2.message.content': 'second message',
      'llm.input_messages.2.message.role': 'user',
    };

    const messages = testBase.lloHandler['collectIndexedMessages'](attributes);

    // Messages should be sorted by pattern key first, then by index
    expect(messages.length).toBe(5);

    // Check gen_ai.prompt messages are in order
    const genAiMessages = messages.filter(m => m.source === 'prompt');
    expect(genAiMessages[0].content).toBe('first prompt');
    expect(genAiMessages[1].content).toBe('third prompt');
    expect(genAiMessages[2].content).toBe('fifth prompt');

    // Check llm.input_messages are in order
    const llmMessages = messages.filter(m => m.content.includes('message'));
    expect(llmMessages[0].content).toBe('second message');
    expect(llmMessages[1].content).toBe('tenth message');
  });

  /**
   * Verify all message collection methods return consistent message format with content,
   * role, and source fields.
   */
  it('should maintain consistent message format across collection methods', () => {
    const attributes: Attributes = {
      'gen_ai.prompt.0.content': 'prompt',
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.completion.0.content': 'response',
      'gen_ai.completion.0.role': 'assistant',
      'traceloop.entity.input': 'input',
      'gen_ai.prompt': 'direct prompt',
      'input.value': 'inference input',
    };

    const span = testBase.createMockSpan(attributes);

    const promptMessages = testBase.lloHandler['collectAllLloMessages'](span, attributes);
    // Check that all messages have the required fields and correct types
    for (const msg of promptMessages) {
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('source');
      expect(typeof msg.content).toBe('string');
      expect(typeof msg.role).toBe('string');
      expect(typeof msg.source).toBe('string');
    }

    const completionMessages = testBase.lloHandler['collectAllLloMessages'](span, attributes);
    for (const msg of completionMessages) {
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('source');
    }

    const traceloopMessages = testBase.lloHandler['collectAllLloMessages'](span, attributes);
    for (const msg of traceloopMessages) {
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('source');
    }

    const openlitMessages = testBase.lloHandler['collectAllLloMessages'](span, attributes);
    for (const msg of openlitMessages) {
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('source');
    }

    const openinferenceMessages = testBase.lloHandler['collectAllLloMessages'](span, attributes);
    for (const msg of openinferenceMessages) {
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('source');
    }
  });
});
