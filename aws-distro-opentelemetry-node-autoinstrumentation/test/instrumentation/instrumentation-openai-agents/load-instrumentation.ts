// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { OpenAIAgentsInstrumentation } from '../../../src/instrumentation/instrumentation-openai-agents/instrumentation';

const agentsInstr = new OpenAIAgentsInstrumentation({ captureMessageContent: true });
const registered = registerInstrumentationTesting(agentsInstr);

if (registered !== agentsInstr) {
  agentsInstr.enable();
}

export const instrumentation = agentsInstr;
