// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import './load-instrumentation';
import { getTestSpans, resetMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { expect } from 'expect';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { ATTR_GEN_AI_OPERATION_NAME } from '../../../src/instrumentation/common/semconv';
import { INSTRUMENTATION_NAME } from '../../../src/instrumentation/instrumentation-langchain/instrumentation';
import { reportCompatibilityDependency } from '../compatibility-test-utils';

describe('LangChain compatibility', function () {
  before(() => {
    reportCompatibilityDependency('@langchain/core');
  });

  beforeEach(() => {
    resetMemoryExporter();
  });

  it('instruments a core chat model invocation', async () => {
    const model = new FakeListChatModel({ responses: ['Hello!'] });
    await model.invoke('Say hello');

    const span = getTestSpans().find(
      candidate =>
        candidate.instrumentationScope.name === INSTRUMENTATION_NAME &&
        candidate.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'chat'
    );
    expect(span).toBeDefined();
  });

  it('instruments a core tool invocation', async () => {
    const addTool = tool(async (input: { a: number; b: number }) => String(input.a + input.b), {
      name: 'add_numbers',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
    });
    await addTool.invoke({ a: 1, b: 2 });

    const span = getTestSpans().find(
      candidate =>
        candidate.instrumentationScope.name === INSTRUMENTATION_NAME &&
        candidate.attributes[ATTR_GEN_AI_OPERATION_NAME] === 'execute_tool'
    );
    expect(span).toBeDefined();
  });
});
