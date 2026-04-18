// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { LangChainInstrumentation } from '../../../src/instrumentation/instrumentation-langchain/instrumentation';

export const instrumentation = registerInstrumentationTesting(
  new LangChainInstrumentation()
) as LangChainInstrumentation;

export const contentCaptureInstrumentation = new LangChainInstrumentation({
  captureMessageContent: true,
});
contentCaptureInstrumentation.disable();
