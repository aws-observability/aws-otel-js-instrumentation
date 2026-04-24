// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import expect from 'expect';
import {
  getAwsRegionFromEnvironment,
  isAgentObservabilityEnabled,
  isAgenticInstrumentationOptIn,
  findInstrumentation,
} from '../src/utils';

describe('Utils', function () {
  beforeEach(() => {
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  it('Test isAgentObservabilityEnabled to be True', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    expect(isAgentObservabilityEnabled()).toBeTruthy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'True';
    expect(isAgentObservabilityEnabled()).toBeTruthy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'TRUE';
    expect(isAgentObservabilityEnabled()).toBeTruthy();
  });

  it('Test isAgentObservabilityEnabled to be False', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'false';
    expect(isAgentObservabilityEnabled()).toBeFalsy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'False';
    expect(isAgentObservabilityEnabled()).toBeFalsy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'FALSE';
    expect(isAgentObservabilityEnabled()).toBeFalsy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'anything else';
    expect(isAgentObservabilityEnabled()).toBeFalsy();

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    expect(isAgentObservabilityEnabled()).toBeFalsy();
  });

  it('Test getAwsRegion from AWS_REGION env var', () => {
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_DEFAULT_REGION = 'eu-west-1';
    expect(getAwsRegionFromEnvironment()).toEqual('us-west-2');
  });

  it('Test getAwsRegion from AWS_DEFAULT_REGION env var', () => {
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = 'eu-west-1';
    expect(getAwsRegionFromEnvironment()).toEqual('eu-west-1');
  });

  it('Test isAgenticInstrumentationOptIn to be True', () => {
    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'true';
    expect(isAgenticInstrumentationOptIn()).toBeTruthy();

    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'True';
    expect(isAgenticInstrumentationOptIn()).toBeTruthy();

    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'TRUE';
    expect(isAgenticInstrumentationOptIn()).toBeTruthy();
  });

  it('Test isAgenticInstrumentationOptIn to be False', () => {
    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'false';
    expect(isAgenticInstrumentationOptIn()).toBeFalsy();

    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'anything else';
    expect(isAgenticInstrumentationOptIn()).toBeFalsy();

    delete process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN;
    expect(isAgenticInstrumentationOptIn()).toBeFalsy();
  });

  describe('findInstrumentation', function () {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const testCases: {
      name: string;
      packagePath: string;
      keywords: string[][];
      expected: string | undefined;
    }[] = [
      {
        name: 'detects @traceloop/instrumentation-langchain',
        packagePath: '@traceloop/instrumentation-langchain',
        keywords: [['langchain'], ['langgraph']],
        expected: '@traceloop/instrumentation-langchain',
      },
      {
        name: 'detects @arizeai/openinference-instrumentation-langchain',
        packagePath: '@arizeai/openinference-instrumentation-langchain',
        keywords: [['langchain'], ['langgraph']],
        expected: '@arizeai/openinference-instrumentation-langchain',
      },
      {
        name: 'langchain keywords do not false-positive on openai package',
        packagePath: '@traceloop/instrumentation-openai',
        keywords: [['langchain'], ['langgraph']],
        expected: undefined,
      },
      {
        name: 'does not false-positive on base openai instrumentation',
        packagePath: '@traceloop/instrumentation-openai',
        keywords: [['openai', 'agents']],
        expected: undefined,
      },
      {
        name: 'detects hypothetical @traceloop/instrumentation-openai-agents',
        packagePath: '@traceloop/instrumentation-openai-agents',
        keywords: [['openai', 'agents']],
        expected: '@traceloop/instrumentation-openai-agents',
      },
      {
        name: 'detects @monocle.sh/instrumentation-vercel-ai',
        packagePath: '@monocle.sh/instrumentation-vercel-ai',
        keywords: [['vercel']],
        expected: '@monocle.sh/instrumentation-vercel-ai',
      },
      {
        name: 'detects @respan/instrumentation-vercel',
        packagePath: '@respan/instrumentation-vercel',
        keywords: [['vercel']],
        expected: '@respan/instrumentation-vercel',
      },
      {
        name: 'detects unscoped opentelemetry-instrumentation-vercel',
        packagePath: 'opentelemetry-instrumentation-vercel',
        keywords: [['vercel']],
        expected: 'opentelemetry-instrumentation-vercel',
      },
      {
        name: 'skips @aws scoped packages',
        packagePath: '@aws/instrumentation-langchain',
        keywords: [['langchain']],
        expected: undefined,
      },
      {
        name: 'skips @opentelemetry scoped packages',
        packagePath: '@opentelemetry/instrumentation-langchain',
        keywords: [['langchain']],
        expected: undefined,
      },
    ];

    for (const tc of testCases) {
      it(tc.name, () => {
        fs.mkdirSync(path.join(tmpDir, tc.packagePath), { recursive: true });
        const result = findInstrumentation(tc.keywords, [tmpDir]);
        if (tc.expected === undefined) {
          expect(result).toBeUndefined();
        } else {
          expect(result).toBe(tc.expected);
        }
      });
    }

    it('returns undefined when node_modules directory does not exist', () => {
      const result = findInstrumentation([['langchain']], [path.join(tmpDir, 'nonexistent')]);
      expect(result).toBeUndefined();
    });
  });
});
