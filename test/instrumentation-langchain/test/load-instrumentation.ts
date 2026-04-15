// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
// Direct path import — the main package's "exports" map doesn't expose internal modules,
// so we resolve the symlinked workspace path and require the build output directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LangChainInstrumentation } = require(
  require('path').resolve(__dirname, '../../../aws-distro-opentelemetry-node-autoinstrumentation/build/src/instrumentation/instrumentation-langchain')
);

export const instrumentation = new LangChainInstrumentation();
registerInstrumentationTesting(instrumentation);
instrumentation.disable();

export const contentCaptureInstrumentation = new LangChainInstrumentation({
  captureMessageContent: true,
});
contentCaptureInstrumentation.disable();
