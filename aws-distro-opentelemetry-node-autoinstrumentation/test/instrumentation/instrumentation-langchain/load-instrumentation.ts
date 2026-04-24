// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { LangChainInstrumentation } from '../../../src/instrumentation/instrumentation-langchain/instrumentation';

const langchainInstr = new LangChainInstrumentation();
const registered = registerInstrumentationTesting(langchainInstr);

// If another instrumentation was already registered as the singleton,
// registerInstrumentationTesting disables ours and returns the existing one.
// Re-enable ours so that langchain tests produce spans.
if (registered !== langchainInstr) {
  langchainInstr.enable();
}

export const instrumentation = langchainInstr;

export const contentCaptureInstrumentation = new LangChainInstrumentation({
  captureMessageContent: true,
});
contentCaptureInstrumentation.disable();
