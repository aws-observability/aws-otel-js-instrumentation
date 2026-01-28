// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { LLO_PATTERNS, LLOHandler, PatternType } from '../src/llo-handler';
import { LLOHandlerTestBase } from './llo-handler.base.test';
import * as sinon from 'sinon';

/**
 * Test pattern matching and recognition functionality.
 */
describe('TestLLOHandlerPatterns', () => {
  let testBase: LLOHandlerTestBase;

  before(() => {
    testBase = new LLOHandlerTestBase();
  });

  after(() => {
    sinon.restore();
  });

  /**
   * Verify LLOHandler initializes correctly with logger provider.
   */
  it('should test init', () => {
    expect(testBase.lloHandler['loggerProvider']).toBeDefined();
    expect(testBase.loggerProviderMock.getLogger).toBeDefined();
  });

  /**
   * Verify isLloAttribute correctly identifies indexed Gen AI prompt patterns (gen_ai.prompt.{n}.content).
   */
  it('should test isLloAttribute match', () => {
    expect(testBase.lloHandler['isLloAttribute']('gen_ai.prompt.0.content')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('gen_ai.prompt.123.content')).toBeTruthy();
  });

  /**
   * Verify isLloAttribute correctly rejects malformed patterns and non-LLO attributes.
   */
  it('should test isLloAttribute no match', () => {
    expect(testBase.lloHandler['isLloAttribute']('gen_ai.prompt.content')).toBeFalsy();
    expect(testBase.lloHandler['isLloAttribute']('gen_ai.prompt.abc.content')).toBeFalsy();
    expect(testBase.lloHandler['isLloAttribute']('some.other.attribute')).toBeFalsy();
  });

  /**
   * Verify isLloAttribute recognizes Traceloop framework patterns (traceloop.entity.input/output).
   */
  it('should test isLloAttribute traceloop match', () => {
    // Test exact matches for Traceloop attributes
    expect(testBase.lloHandler['isLloAttribute']('traceloop.entity.input')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('traceloop.entity.output')).toBeTruthy();
  });

  /**
   * Verify isLloAttribute recognizes OpenLit framework patterns (gen_ai.prompt, gen_ai.completion, etc.).
   */
  it('should test isLloAttribute openlit match', () => {
    // Test exact matches for direct OpenLit attributes
    expect(testBase.lloHandler['isLloAttribute']('gen_ai.prompt')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('gen_ai.completion')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('gen_ai.content.revised_prompt')).toBeTruthy();
  });

  /**
   * Verify isLloAttribute recognizes OpenInference patterns including both direct (input/output.value)
   * and indexed (llm.input_messages.{n}.message.content) patterns.
   */
  it('should test isLloAttribute openinference match', () => {
    expect(testBase.lloHandler['isLloAttribute']('input.value')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('output.value')).toBeTruthy();

    expect(testBase.lloHandler['isLloAttribute']('llm.input_messages.0.message.content')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('llm.output_messages.123.message.content')).toBeTruthy();
  });

  /**
   * Verify isLloAttribute recognizes CrewAI framework patterns (gen_ai.agent.*, crewai.crew.*).
   */
  it('should test isLloAttribute crewai match', () => {
    expect(testBase.lloHandler['isLloAttribute']('gen_ai.agent.actual_output')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('gen_ai.agent.human_input')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('crewai.crew.tasks_output')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('crewai.crew.result')).toBeTruthy();
  });

  /**
   * Verify isLloAttribute recognizes Strands SDK patterns (system_prompt, tool.result).
   */
  it('should test isLloAttribute strands sdk match', () => {
    expect(testBase.lloHandler['isLloAttribute']('system_prompt')).toBeTruthy();
    expect(testBase.lloHandler['isLloAttribute']('tool.result')).toBeTruthy();
  });

  /**
   * Verify isLloAttribute recognizes llm.prompts pattern.
   */
  it('should test isLloAttribute llm_prompts match', () => {
    expect(testBase.lloHandler['isLloAttribute']('llm.prompts')).toBeTruthy();
  });

  /**
   * Test buildPatternMatchers handles patterns with missing regex gracefully.
   */
  it('should test build pattern matchers with missing regex', () => {
    // Temporarily modify LLO_PATTERNS to have a pattern without regex
    const originalPatterns = { ...LLO_PATTERNS };

    // Add a malformed indexed pattern without regex
    const testPattern = 'test.bad.pattern';
    (LLO_PATTERNS as any)[testPattern] = {
      type: PatternType.INDEXED,
      // Missing "regex" key
      roleKey: 'test.bad.pattern.role',
      defaultRole: 'unknown',
      source: 'test',
    };

    try {
      // Create a new handler to trigger pattern building
      const handler = new LLOHandler(testBase.loggerProviderMock);

      // Should handle gracefully - the bad pattern should be skipped
      expect((handler as any).patternConfigs).not.toHaveProperty(testPattern);

      // Other patterns should still work
      expect(handler['isLloAttribute']('gen_ai.prompt')).toBeTruthy();
      expect(handler['isLloAttribute']('test.bad.pattern')).toBeFalsy();
    } finally {
      // Restore original patterns
      Object.keys(LLO_PATTERNS).forEach(key => delete LLO_PATTERNS[key]);
      Object.assign(LLO_PATTERNS, originalPatterns);
    }
  });
});
