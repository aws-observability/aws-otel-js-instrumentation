// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */

import './load-instrumentation';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { expect } from 'expect';
import { ATTR_GEN_AI_AGENT_NAME, ATTR_GEN_AI_OPERATION_NAME } from '../../../src/instrumentation/common/semconv';
import { getInstalledPackageVersion, reportCompatibilityDependency } from '../compatibility-test-utils';

describe('OpenAI Agents compatibility', function () {
  before(() => {
    const agentsVersion = reportCompatibilityDependency('@openai/agents');
    expect(getInstalledPackageVersion('@openai/agents-core')).toBe(agentsVersion);
  });

  beforeEach(() => {
    resetMemoryExporter();
  });

  it('instruments SDK agent and generation spans', async () => {
    const { withTrace, withAgentSpan, withGenerationSpan, withFunctionSpan } = require('@openai/agents') as {
      withTrace: (name: string, fn: () => Promise<void>) => Promise<void>;
      withAgentSpan: (fn: () => Promise<void>, options: any) => Promise<void>;
      withGenerationSpan: (fn: () => Promise<void>, options: any) => Promise<void>;
      withFunctionSpan: (fn: () => Promise<void>, options: any) => Promise<void>;
    };

    await withTrace('compatibility-trace', async () => {
      await withAgentSpan(
        async () => {
          await withGenerationSpan(async () => {}, {
            data: {
              input: [{ role: 'user', content: 'Hello' }],
              output: [{ role: 'assistant', content: 'Hi!' }],
              model: 'compatibility-model',
              model_config: {},
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          });
          await withFunctionSpan(async () => {}, {
            data: {
              name: 'compatibility-tool',
              input: '{}',
              output: 'ok',
            },
          });
        },
        {
          data: {
            name: 'CompatibilityAgent',
            tools: [],
            handoffs: [],
            output_type: 'text',
          },
        }
      );
    });

    const spans = getTestSpans();
    const agentSpan = spans.find(span => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'invoke_agent');
    const generationSpan = spans.find(span => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    const functionSpan = spans.find(span => span.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool');

    expect(agentSpan).toBeDefined();
    expect(agentSpan!.attributes[ATTR_GEN_AI_AGENT_NAME]).toBe('CompatibilityAgent');
    expect(generationSpan).toBeDefined();
    expect(generationSpan!.parentSpanContext?.spanId).toBe(agentSpan!.spanContext().spanId);
    expect(functionSpan).toBeDefined();
    expect(functionSpan!.parentSpanContext?.spanId).toBe(agentSpan!.spanContext().spanId);
  });
});
