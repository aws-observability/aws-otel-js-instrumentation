// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { LangChainInstrumentation } from '@aws/aws-distro-opentelemetry-node-autoinstrumentation/instrumentation-langchain';

export const instrumentation = new LangChainInstrumentation();
registerInstrumentationTesting(instrumentation);
instrumentation.disable();

export const contentCaptureInstrumentation = new LangChainInstrumentation({
  captureMessageContent: true,
});
contentCaptureInstrumentation.disable();
