// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { LangChainInstrumentation } from '../src/instrumentation';

describe('LangChainInstrumentation', () => {
  let instrumentation: LangChainInstrumentation;

  beforeEach(() => {
    instrumentation = new LangChainInstrumentation();
  });

  afterEach(() => {
    instrumentation.disable();
  });

  describe('constructor', () => {
    it('has correct instrumentation name', () => {
      expect(instrumentation.instrumentationName).toBe('opentelemetry-instrumentation-langchain');
    });

    it('has a version', () => {
      expect(instrumentation.instrumentationVersion).toBeDefined();
      expect(typeof instrumentation.instrumentationVersion).toBe('string');
    });
  });

  describe('enable/disable', () => {
    it('can be enabled and disabled without error', () => {
      expect(() => instrumentation.enable()).not.toThrow();
      expect(() => instrumentation.disable()).not.toThrow();
    });
  });
});
