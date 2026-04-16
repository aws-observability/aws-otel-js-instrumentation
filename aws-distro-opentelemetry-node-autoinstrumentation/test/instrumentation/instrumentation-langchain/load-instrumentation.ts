// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTestMemoryExporter, setTestMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangChainInstrumentation } from '../../../src/instrumentation/instrumentation-langchain';

export const instrumentation = new LangChainInstrumentation();
instrumentation.disable();

export const contentCaptureInstrumentation = new LangChainInstrumentation({
  captureMessageContent: true,
});
contentCaptureInstrumentation.disable();

// Override enable() on both instrumentations to ensure the LangChain instrumentation for register.ts doesn't double patch langchain. We have to
// lazily create a NodeTracerProvider that writes to the shared InMemorySpanExporter, then re-patch langchain so our handler is active.
//
// Wrapped in try/catch for Node < 20 where @langchain/core is unavailable.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CallbackManager } = require('@langchain/core/callbacks/manager');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { StructuredTool } = require('@langchain/core/tools');

  let testProvider: NodeTracerProvider | undefined;

  const ensureTestProvider = (): NodeTracerProvider => {
    if (testProvider) return testProvider;
    let exporter = getTestMemoryExporter();
    if (!exporter) {
      exporter = new InMemorySpanExporter();
      setTestMemoryExporter(exporter);
    }
    testProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    return testProvider;
  };

  const patchOnEnable = (instr: LangChainInstrumentation): void => {
    const origEnable = instr.enable.bind(instr);
    instr.enable = () => {
      origEnable();
      instr.setTracerProvider(ensureTestProvider());
      instr._handler = undefined;
      instr._patchCallbackManager(CallbackManager);
      instr._patchChatModelsModule({ BaseChatModel });
      instr._patchToolsModule({ StructuredTool });
    };
  };

  patchOnEnable(instrumentation);
  patchOnEnable(contentCaptureInstrumentation);
} catch {
  // @langchain/core not available (e.g. Node < 20) — tests will be skipped naturally
}
