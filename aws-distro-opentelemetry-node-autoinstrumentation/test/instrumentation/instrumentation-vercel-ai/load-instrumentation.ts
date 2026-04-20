// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { trace } from '@opentelemetry/api';
import { VercelAIInstrumentation } from '../../../src/instrumentation/instrumentation-vercel-ai/instrumentation';
import { VercelAISpanProcessor } from '../../../src/instrumentation/instrumentation-vercel-ai/span-processor';

export const instrumentation = new VercelAIInstrumentation({
  captureMessageContent: false,
});
registerInstrumentationTesting(instrumentation);

const provider = trace.getTracerProvider() as any;
const delegate = provider.getDelegate?.() ?? provider;
const processors = delegate?._registeredSpanProcessors ?? delegate?._activeSpanProcessor?._spanProcessors;
if (Array.isArray(processors)) {
  processors.unshift(new VercelAISpanProcessor());
} else if (typeof delegate?.addSpanProcessor === 'function') {
  delegate.addSpanProcessor(new VercelAISpanProcessor());
}
