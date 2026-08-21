// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */

import { SpanKind } from '@opentelemetry/api';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { expect } from 'expect';
import { ensureSpanProcessor } from './load-instrumentation';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from '../../../src/instrumentation/common/semconv';
import { OPENAI_MODEL, FAKE_OPENAI_KEY, getProviderCases, ProviderName, mockFetchJson } from '../test-fixtures';
import { reportCompatibilityDependency } from '../compatibility-test-utils';

describe('Vercel AI compatibility', function () {
  before(() => {
    reportCompatibilityDependency('ai');
    reportCompatibilityDependency('@ai-sdk/openai');
    ensureSpanProcessor();
  });

  beforeEach(() => {
    resetMemoryExporter();
  });

  it('enables telemetry and translates a real provider invocation', async () => {
    const { generateText } = require('ai');
    const { createOpenAI } = require('@ai-sdk/openai');
    const response = getProviderCases().find(testCase => testCase.name === ProviderName.OPENAI)!.chatResponse;
    const provider = createOpenAI({
      apiKey: FAKE_OPENAI_KEY,
      fetch: mockFetchJson(response),
    });
    const model = typeof provider.chat === 'function' ? provider.chat(OPENAI_MODEL) : provider(OPENAI_MODEL);

    const result = await generateText({
      model,
      prompt: 'What is the capital of France?',
    });
    expect(result.text).toContain('Paris');

    const span = getTestSpans().find(candidate => candidate.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat');
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(span!.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('openai');
    expect(span!.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe(OPENAI_MODEL);
    expect(span!.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(18);
    expect(span!.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(8);
  });
});
