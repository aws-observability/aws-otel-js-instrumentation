// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, HrTime } from '@opentelemetry/api';
import expect from 'expect';
import { LLOHandlerTestBase } from './llo-handler.base.test';
import type { InstrumentationScope } from '@opentelemetry/core';
import * as sinon from 'sinon';

/**
 * Test framework-specific LLO attribute handling.
 */
describe('TestLLOHandlerFrameworks', () => {
  let testBase: LLOHandlerTestBase;

  beforeEach(() => {
    testBase = new LLOHandlerTestBase();
  });

  afterEach(() => {
    sinon.restore();
  });

  /**
   * Verify Traceloop entity input/output attributes are collected with correct roles
   * (input->user, output->assistant).
   */
  it('should collect Traceloop messages', () => {
    const attributes: Attributes = {
      'traceloop.entity.input': 'input data',
      'traceloop.entity.output': 'output data',
      'traceloop.entity.name': 'my_entity',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    const traceloopMessages = messages.filter(m => ['input', 'output'].includes(m.source));

    expect(traceloopMessages.length).toBe(2);

    const inputMessage = traceloopMessages[0];
    expect(inputMessage.content).toBe('input data');
    expect(inputMessage.role).toBe('user');
    expect(inputMessage.source).toBe('input');

    const outputMessage = traceloopMessages[1];
    expect(outputMessage.content).toBe('output data');
    expect(outputMessage.role).toBe('assistant');
    expect(outputMessage.source).toBe('output');
  });

  /**
   * Verify collection of mixed Traceloop and CrewAI attributes, ensuring all are collected
   * with appropriate roles and sources.
   */
  it('should collect Traceloop messages with all attributes', () => {
    const attributes: Attributes = {
      'traceloop.entity.input': 'input data',
      'traceloop.entity.output': 'output data',
      'crewai.crew.tasks_output': "[TaskOutput(description='Task 1', output='Result 1')]",
      'crewai.crew.result': 'Final crew result',
      'traceloop.entity.name': 'crewai_agent',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(4);

    expect(messages[0].content).toBe('input data');
    expect(messages[0].role).toBe('user');
    expect(messages[0].source).toBe('input');

    expect(messages[1].content).toBe('output data');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].source).toBe('output');

    expect(messages[2].content).toBe("[TaskOutput(description='Task 1', output='Result 1')]");
    expect(messages[2].role).toBe('assistant');
    expect(messages[2].source).toBe('output');

    expect(messages[3].content).toBe('Final crew result');
    expect(messages[3].role).toBe('assistant');
    expect(messages[3].source).toBe('result');
  });

  /**
   * Verify OpenLit's direct gen_ai.prompt attribute is collected with user role and prompt source.
   */
  it('should collect OpenLit messages with direct prompt', () => {
    const attributes: Attributes = { 'gen_ai.prompt': 'user direct prompt' };

    const span = testBase.createMockSpan(attributes);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('user direct prompt');
    expect(message.role).toBe('user');
    expect(message.source).toBe('prompt');
  });

  /**
   * Verify OpenLit's direct gen_ai.completion attribute is collected with assistant role and completion source.
   */
  it('should collect OpenLit messages with direct completion', () => {
    const attributes: Attributes = { 'gen_ai.completion': 'assistant direct completion' };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('assistant direct completion');
    expect(message.role).toBe('assistant');
    expect(message.source).toBe('completion');
  });

  /**
   * Verify all OpenLit framework attributes (prompt, completion, revised_prompt, agent.*)
   * are collected with correct roles and sources.
   */
  it('should collect OpenLit messages with all attributes', () => {
    const attributes: Attributes = {
      'gen_ai.prompt': 'user prompt',
      'gen_ai.completion': 'assistant response',
      'gen_ai.content.revised_prompt': 'revised prompt',
      'gen_ai.agent.actual_output': 'agent output',
      'gen_ai.agent.human_input': 'human input to agent',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(5);

    expect(messages[0].content).toBe('user prompt');
    expect(messages[0].role).toBe('user');
    expect(messages[0].source).toBe('prompt');

    expect(messages[1].content).toBe('assistant response');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].source).toBe('completion');

    expect(messages[2].content).toBe('revised prompt');
    expect(messages[2].role).toBe('system');
    expect(messages[2].source).toBe('prompt');

    expect(messages[3].content).toBe('agent output');
    expect(messages[3].role).toBe('assistant');
    expect(messages[3].source).toBe('output');

    expect(messages[4].content).toBe('human input to agent');
    expect(messages[4].role).toBe('user');
    expect(messages[4].source).toBe('input');
  });

  /**
   * Verify OpenLit's gen_ai.content.revised_prompt is collected with system role and prompt source.
   */
  it('should collect OpenLit messages with revised prompt', () => {
    const attributes: Attributes = { 'gen_ai.content.revised_prompt': 'revised system prompt' };

    const span = testBase.createMockSpan(attributes);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('revised system prompt');
    expect(message.role).toBe('system');
    expect(message.source).toBe('prompt');
  });

  /**
   * Verify OpenInference's direct input.value and output.value attributes are collected
   * with appropriate roles (user/assistant) and sources.
   */
  it('should collect OpenInference messages with direct attributes', () => {
    const attributes: Attributes = {
      'input.value': 'user prompt',
      'output.value': 'assistant response',
      'llm.model_name': 'gpt-4',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(2);

    const inputMessage = messages[0];
    expect(inputMessage.content).toBe('user prompt');
    expect(inputMessage.role).toBe('user');
    expect(inputMessage.source).toBe('input');

    const outputMessage = messages[1];
    expect(outputMessage.content).toBe('assistant response');
    expect(outputMessage.role).toBe('assistant');
    expect(outputMessage.source).toBe('output');
  });

  /**
   * Verify OpenInference's indexed llm.input_messages.{n}.message.content attributes
   * are collected with roles from corresponding role attributes.
   */
  it('should collect OpenInference messages with structured input', () => {
    const attributes: Attributes = {
      'llm.input_messages.0.message.content': 'system prompt',
      'llm.input_messages.0.message.role': 'system',
      'llm.input_messages.1.message.content': 'user message',
      'llm.input_messages.1.message.role': 'user',
      'llm.model_name': 'claude-3',
    };

    const span = testBase.createMockSpan(attributes);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(2);

    const systemMessage = messages[0];
    expect(systemMessage.content).toBe('system prompt');
    expect(systemMessage.role).toBe('system');
    expect(systemMessage.source).toBe('input');

    const userMessage = messages[1];
    expect(userMessage.content).toBe('user message');
    expect(userMessage.role).toBe('user');
    expect(userMessage.source).toBe('input');
  });

  /**
   * Verify OpenInference's indexed llm.output_messages.{n}.message.content attributes
   * are collected with source='output' and roles from corresponding attributes.
   */
  it('should collect OpenInference messages with structured output', () => {
    const attributes: Attributes = {
      'llm.output_messages.0.message.content': 'assistant response',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.model_name': 'llama-3',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);

    const outputMessage = messages[0];
    expect(outputMessage.content).toBe('assistant response');
    expect(outputMessage.role).toBe('assistant');
    expect(outputMessage.source).toBe('output');
  });

  /**
   * Verify mixed OpenInference attributes (direct and indexed) are all collected
   * and maintain correct roles and counts.
   */
  it('should collect OpenInference messages with mixed attributes', () => {
    const attributes: Attributes = {
      'input.value': 'direct input',
      'output.value': 'direct output',
      'llm.input_messages.0.message.content': 'message input',
      'llm.input_messages.0.message.role': 'user',
      'llm.output_messages.0.message.content': 'message output',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.model_name': 'bedrock.claude-3',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(4);

    const contents = messages.map(msg => msg.content);
    expect(contents).toContain('direct input');
    expect(contents).toContain('direct output');
    expect(contents).toContain('message input');
    expect(contents).toContain('message output');

    const roles = messages.map(msg => msg.role);
    expect(roles.filter(role => role === 'user').length).toBe(2);
    expect(roles.filter(role => role === 'assistant').length).toBe(2);
  });

  /**
   * Verify OpenLit's gen_ai.agent.actual_output is collected with assistant role and output source.
   */
  it('should collect OpenLit messages with agent actual output', () => {
    const attributes: Attributes = { 'gen_ai.agent.actual_output': 'Agent task output result' };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);

    const message = messages[0];
    expect(message.content).toBe('Agent task output result');
    expect(message.role).toBe('assistant');
    expect(message.source).toBe('output');
  });

  /**
   * Verify OpenLit's gen_ai.agent.human_input is collected with user role and input source.
   */
  it('should collect OpenLit messages with agent human input', () => {
    const attributes: Attributes = { 'gen_ai.agent.human_input': 'Human input to the agent' };

    const span = testBase.createMockSpan(attributes);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe('Human input to the agent');
    expect(message.role).toBe('user');
    expect(message.source).toBe('input');
  });

  /**
   * Verify CrewAI-specific attributes (tasks_output, result) are collected with assistant role
   * and appropriate sources.
   */
  it('should collect Traceloop messages with crew outputs', () => {
    const attributes: Attributes = {
      'crewai.crew.tasks_output': "[TaskOutput(description='Task description', output='Task result')]",
      'crewai.crew.result': 'Final crew execution result',
      'traceloop.entity.name': 'crewai',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(2);

    const tasksMessage = messages[0];
    expect(tasksMessage.content).toBe("[TaskOutput(description='Task description', output='Task result')]");
    expect(tasksMessage.role).toBe('assistant');
    expect(tasksMessage.source).toBe('output');

    const resultMessage = messages[1];
    expect(resultMessage.content).toBe('Final crew execution result');
    expect(resultMessage.role).toBe('assistant');
    expect(resultMessage.source).toBe('result');
  });

  /**
   * Verify OpenInference indexed messages use default roles (user for input, assistant for output)
   * when role attributes are missing.
   */
  it('should handle OpenInference messages with default roles', () => {
    const attributes: Attributes = {
      'llm.input_messages.0.message.content': 'input without role',
      'llm.output_messages.0.message.content': 'output without role',
    };

    const span = testBase.createMockSpan(attributes);

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(2);

    const inputMsg = messages.find(m => m.content === 'input without role');
    expect(inputMsg).toBeDefined();
    expect(inputMsg!.role).toBe('user');
    expect(inputMsg!.source).toBe('input');

    const outputMsg = messages.find(m => m.content === 'output without role');
    expect(outputMsg).toBeDefined();
    expect(outputMsg!.role).toBe('assistant');
    expect(outputMsg!.source).toBe('output');
  });

  /**
   * Verify Strands SDK patterns (system_prompt, tool.result) are collected
   * with correct roles and sources.
   */
  it('should collect Strands SDK messages', () => {
    const attributes: Attributes = {
      system_prompt: 'You are a helpful assistant',
      'tool.result': 'Tool execution completed successfully',
    };

    const span = testBase.createMockSpan(attributes);
    testBase.updateMockSpanKey<HrTime>(span, 'endTime', [1234567899, 0]);
    testBase.updateMockSpanKey<InstrumentationScope>(span, 'instrumentationScope', {
      name: 'strands.sdk',
      version: '1.0.0',
    });

    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(2);

    const systemMsg = messages.find(m => m.content === 'You are a helpful assistant');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.role).toBe('system');
    expect(systemMsg!.source).toBe('prompt');

    const toolMsg = messages.find(m => m.content === 'Tool execution completed successfully');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.role).toBe('assistant');
    expect(toolMsg!.source).toBe('output');
  });

  /**
   * Verify llm.prompts attribute is collected as a user message with prompt source.
   */
  it('should collect llm.prompts messages', () => {
    const attributes: Attributes = {
      'llm.prompts':
        "[{'role': 'system', 'content': [{'text': 'You are a helpful AI assistant.', 'type': 'text'}]}, " +
        "{'role': 'user', 'content': [{'text': 'What are the benefits of using FastAPI?', 'type': 'text'}]}]",
      'other.attribute': 'not collected',
    };

    const span = testBase.createMockSpan(attributes);
    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(1);
    const message = messages[0];
    expect(message.content).toBe(attributes['llm.prompts']);
    expect(message.role).toBe('user');
    expect(message.source).toBe('prompt');
  });

  /**
   * Verify llm.prompts works correctly alongside other LLO attributes.
   */
  it('should collect llm.prompts with other messages', () => {
    const attributes: Attributes = {
      'llm.prompts': "[{'role': 'system', 'content': 'System prompt'}]",
      'gen_ai.prompt': 'Direct prompt',
      'gen_ai.completion': 'Assistant response',
    };

    const span = testBase.createMockSpan(attributes);
    const messages = testBase.lloHandler['collectAllLloMessages'](span, attributes);

    expect(messages.length).toBe(3);

    // Check llm.prompts message
    const llmPromptsMsg = messages.find(m => m.content === attributes['llm.prompts']);
    expect(llmPromptsMsg).toBeDefined();
    expect(llmPromptsMsg!.role).toBe('user');
    expect(llmPromptsMsg!.source).toBe('prompt');

    // Check other messages are still collected
    const directPromptMsg = messages.find(m => m.content === 'Direct prompt');
    expect(directPromptMsg).toBeDefined();

    const completionMsg = messages.find(m => m.content === 'Assistant response');
    expect(completionMsg).toBeDefined();
  });
});
