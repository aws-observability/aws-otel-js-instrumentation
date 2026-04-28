// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { OpenAIAgentsInstrumentation } from '../../../src/instrumentation/instrumentation-openai-agents/instrumentation';

const agentsInstr = new OpenAIAgentsInstrumentation({ captureMessageContent: true });
// Cast through unknown due to private field mismatch between @opentelemetry/instrumentation versions
const registered = registerInstrumentationTesting(agentsInstr as unknown as Parameters<typeof registerInstrumentationTesting>[0]);

if ((registered as unknown) !== agentsInstr) {
  agentsInstr.enable();
}

export const instrumentation = agentsInstr;
