// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import * as assert from 'assert';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import expect from 'expect';
import * as opentelemetry from '@opentelemetry/sdk-node';
import * as sinon from 'sinon';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  LangChainInstrumentation,
  INSTRUMENTATION_SHORT_NAME as LANGCHAIN_SHORT_NAME,
  INSTRUMENTATION_NAME as LANGCHAIN_NAME,
} from '../src/instrumentation/instrumentation-langchain/instrumentation';
import {
  OpenAIAgentsInstrumentation,
  INSTRUMENTATION_SHORT_NAME as OPENAI_AGENTS_SHORT_NAME,
  INSTRUMENTATION_NAME as OPENAI_AGENTS_NAME,
} from '../src/instrumentation/instrumentation-openai-agents/instrumentation';
import {
  VercelAIInstrumentation,
  INSTRUMENTATION_SHORT_NAME as VERCEL_AI_SHORT_NAME,
  INSTRUMENTATION_NAME as VERCEL_AI_NAME,
} from '../src/instrumentation/instrumentation-vercel-ai/instrumentation';

// The OpenTelemetry Authors code
// Extend register.test.ts functionality to also test exported span with Application Signals enabled
describe('Register', function () {
  let instrumentations: any[];
  let setAwsDefaultEnvironmentVariables: () => void;

  before(() => {
    const stub = sinon.stub(opentelemetry.NodeSDK.prototype, 'start');
    const register = require('../src/register');
    stub.restore();
    instrumentations = register.instrumentations;
    setAwsDefaultEnvironmentVariables = register.setAwsDefaultEnvironmentVariables;
    for (const instr of instrumentations) {
      instr.disable();
    }
  });

  describe('register instrumentation', () => {
    const baseEnv = {
      ...process.env,
      OTEL_NODE_RESOURCE_DETECTORS: 'none',
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_LOG_LEVEL: 'NONE',
    };

    const spawnWithAssertion = (env: Record<string, string | undefined>, assertion: string) => {
      const script = `
        const assert = require('assert');
        const register = require('../build/src/register.js');
        const instrumentations = register.instrumentations;
        const names = instrumentations.map(i => i.instrumentationName);
        ${assertion}
        process.exit(0);
      `;
      return spawnSync(process.execPath, ['-e', script], {
        cwd: __dirname,
        timeout: 10000,
        killSignal: 'SIGKILL',
        env: { ...baseEnv, ...env },
      });
    };

    const testInstrumentation = (instrumentationClass: any, fullName: string, shortName: string) => {
      describe(shortName, () => {
        it('is registered by default', () => {
          const found = instrumentations.find((i: any) => i instanceof instrumentationClass);
          assert.ok(found, `${fullName} should be in the instrumentations list`);
          assert.strictEqual(found.instrumentationName, fullName);
        });

        it('is disabled via OTEL_NODE_DISABLED_INSTRUMENTATIONS', () => {
          const proc = spawnWithAssertion(
            { OTEL_NODE_DISABLED_INSTRUMENTATIONS: shortName },
            `const instr = instrumentations.find(i => i.instrumentationName === '${fullName}');
             assert.ok(instr, '${fullName} should be registered');
             assert.ok(!instr.isEnabled(), '${fullName} should be disabled');`
          );
          assert.ifError(proc.error);
          assert.equal(proc.status, 0, proc.stderr?.toString());
        });

        it('is disabled when OTEL_NODE_ENABLED_INSTRUMENTATIONS is set without it', () => {
          const proc = spawnWithAssertion(
            { OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'http' },
            `const instr = instrumentations.find(i => i.instrumentationName === '${fullName}');
             assert.ok(instr, '${fullName} should be registered');
             assert.ok(!instr.isEnabled(), '${fullName} should be disabled');`
          );
          assert.ifError(proc.error);
          assert.equal(proc.status, 0, proc.stderr?.toString());
        });

        it('is enabled when OTEL_NODE_ENABLED_INSTRUMENTATIONS includes it', () => {
          const proc = spawnWithAssertion(
            { OTEL_NODE_ENABLED_INSTRUMENTATIONS: `http,${shortName}` },
            `assert.ok(names.includes('${fullName}'));`
          );
          assert.ifError(proc.error);
          assert.equal(proc.status, 0, proc.stderr?.toString());
        });
      });
    };

    testInstrumentation(LangChainInstrumentation, LANGCHAIN_NAME, LANGCHAIN_SHORT_NAME);
    testInstrumentation(OpenAIAgentsInstrumentation, OPENAI_AGENTS_NAME, OPENAI_AGENTS_SHORT_NAME);
    testInstrumentation(VercelAIInstrumentation, VERCEL_AI_NAME, VERCEL_AI_SHORT_NAME);

    describe('third-party conflict detection', () => {
      const conflictTestCases: {
        name: string;
        fakePackage: string;
        instrumentationName: string;
        expectedDisabled: boolean;
        optIn?: boolean;
      }[] = [
        {
          name: 'disables LangChain when @traceloop/instrumentation-langchain is installed',
          fakePackage: '@traceloop/instrumentation-langchain',
          instrumentationName: LANGCHAIN_NAME,
          expectedDisabled: true,
        },
        {
          name: 'disables LangChain when @arizeai/openinference-instrumentation-langchain is installed',
          fakePackage: '@arizeai/openinference-instrumentation-langchain',
          instrumentationName: LANGCHAIN_NAME,
          expectedDisabled: true,
        },
        {
          name: 'disables LangChain when @arizeai/openinference-instrumentation-langchain-v0 is installed',
          fakePackage: '@arizeai/openinference-instrumentation-langchain-v0',
          instrumentationName: LANGCHAIN_NAME,
          expectedDisabled: true,
        },
        {
          name: 'disables LangChain when @microsoft/agents-a365-observability-extensions-langchain is installed',
          fakePackage: '@microsoft/agents-a365-observability-extensions-langchain',
          instrumentationName: LANGCHAIN_NAME,
          expectedDisabled: true,
        },
        {
          name: 'disables LangChain when @langfuse/langchain is installed',
          fakePackage: '@langfuse/langchain',
          instrumentationName: LANGCHAIN_NAME,
          expectedDisabled: true,
        },
        {
          name: 'enables LangChain with @traceloop/instrumentation-langchain when opt-in',
          fakePackage: '@traceloop/instrumentation-langchain',
          instrumentationName: LANGCHAIN_NAME,
          expectedDisabled: false,
          optIn: true,
        },
        {
          name: 'disables OpenAI Agents when @respan/instrumentation-openai-agents is installed',
          fakePackage: '@respan/instrumentation-openai-agents',
          instrumentationName: OPENAI_AGENTS_NAME,
          expectedDisabled: true,
        },
        {
          name: 'disables OpenAI Agents when @microsoft/agents-a365-observability-extensions-openai is installed',
          fakePackage: '@microsoft/agents-a365-observability-extensions-openai',
          instrumentationName: OPENAI_AGENTS_NAME,
          expectedDisabled: true,
        },
        {
          name: 'enables OpenAI Agents with @respan/instrumentation-openai-agents when opt-in',
          fakePackage: '@respan/instrumentation-openai-agents',
          instrumentationName: OPENAI_AGENTS_NAME,
          expectedDisabled: false,
          optIn: true,
        },
        {
          name: 'does not disable OpenAI Agents when @traceloop/instrumentation-openai is installed',
          fakePackage: '@traceloop/instrumentation-openai',
          instrumentationName: OPENAI_AGENTS_NAME,
          expectedDisabled: false,
        },
        {
          name: 'disables Vercel AI when @monocle.sh/instrumentation-vercel-ai is installed',
          fakePackage: '@monocle.sh/instrumentation-vercel-ai',
          instrumentationName: VERCEL_AI_NAME,
          expectedDisabled: true,
        },
        {
          name: 'disables Vercel AI when @respan/instrumentation-vercel is installed',
          fakePackage: '@respan/instrumentation-vercel',
          instrumentationName: VERCEL_AI_NAME,
          expectedDisabled: true,
        },
        {
          name: 'enables Vercel AI with @monocle.sh/instrumentation-vercel-ai when opt-in',
          fakePackage: '@monocle.sh/instrumentation-vercel-ai',
          instrumentationName: VERCEL_AI_NAME,
          expectedDisabled: false,
          optIn: true,
        },
      ];

      for (const tc of conflictTestCases) {
        it(tc.name, () => {
          const script = `
            const assert = require('assert');
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-conflict-'));
            const pkgDir = path.join(tmpDir, '${tc.fakePackage}');
            fs.mkdirSync(pkgDir, { recursive: true });
            fs.writeFileSync(path.join(pkgDir, 'index.js'), '');
            process.env.NODE_PATH = tmpDir;
            require('module').Module._initPaths();
            const register = require('../build/src/register.js');
            const instr = register.instrumentations.find(
              i => i.instrumentationName === '${tc.instrumentationName}'
            );
            assert.ok(instr, '${tc.instrumentationName} should be registered');
            assert.strictEqual(
              instr.isEnabled(), ${!tc.expectedDisabled},
              '${tc.instrumentationName} should be ${tc.expectedDisabled ? 'disabled' : 'enabled'}'
            );
            fs.rmSync(tmpDir, { recursive: true, force: true });
            process.exit(0);
          `;
          const env: Record<string, string | undefined> = {};
          if (tc.optIn) {
            env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'true';
          }
          const proc = spawnSync(process.execPath, ['-e', script], {
            cwd: __dirname,
            timeout: 10000,
            killSignal: 'SIGKILL',
            env: { ...baseEnv, ...env },
          });
          assert.ifError(proc.error);
          assert.equal(proc.status, 0, proc.stderr?.toString());
        });
      }
    });

    it('Vercel AI auto-registers VercelAISpanProcessor', () => {
      const provider = new BasicTracerProvider();
      trace.setGlobalTracerProvider(provider);

      const instr = new VercelAIInstrumentation();
      instr.setTracerProvider(trace.getTracerProvider() as any);

      const delegate = (trace.getTracerProvider() as any).getDelegate?.() ?? provider;
      const processors = delegate._activeSpanProcessor?._spanProcessors ?? [];
      assert.ok(
        processors.some((p: any) => p.constructor.name === 'VercelAISpanProcessor'),
        'VercelAISpanProcessor should be auto-registered'
      );

      instr.disable();
      trace.disable();
    });
  });

  it('Requires without error', () => {
    const proc: SpawnSyncReturns<Buffer> = spawnSync(
      process.execPath,
      ['--require', '../build/src/register.js', '-e', 'process.exit(0)'],
      {
        cwd: __dirname,
        timeout: 10000,
        killSignal: 'SIGKILL',
        env: Object.assign({}, process.env, {
          OTEL_NODE_RESOURCE_DETECTORS: 'none',
          OTEL_TRACES_EXPORTER: 'none',
          OTEL_METRICS_EXPORTER: 'none',
          OTEL_LOGS_EXPORTER: 'none',
        }),
      }
    );
    assert.ifError(proc.error);
    assert.equal(proc.status, 0, `proc.status (${proc.status})`);
  });

  describe('Tests AWS Default Environment Variables', () => {
    beforeEach(() => {
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
      delete process.env.OTEL_PROPAGATORS;
      delete process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS;
      delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;

      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      delete process.env.AGENT_OBSERVABILITY_ENABLED;
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      delete process.env.OTEL_TRACES_EXPORTER;
      delete process.env.OTEL_LOGS_EXPORTER;
      delete process.env.OTEL_METRICS_EXPORTER;

      delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      delete process.env.OTEL_TRACES_SAMPLER;
      delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    });

    it('sets AWS Default Environment Variables', () => {
      setAwsDefaultEnvironmentVariables();
      expect(process.env.OTEL_EXPORTER_OTLP_PROTOCOL).toEqual('http/protobuf');
      expect(process.env.OTEL_PROPAGATORS).toEqual('baggage,xray,tracecontext');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('fs,dns');
    });

    it('Does not set AWS Default Environment Variables', () => {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'customProtocol';
      process.env.OTEL_PROPAGATORS = 'customPropagators';
      process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'customDisabledInstrumentations';
      setAwsDefaultEnvironmentVariables();
      expect(process.env.OTEL_EXPORTER_OTLP_PROTOCOL).toEqual('customProtocol');
      expect(process.env.OTEL_PROPAGATORS).toEqual('customPropagators');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('customDisabledInstrumentations');
    });

    it('Configures with AgentObservabilityEnabled with unset region', () => {
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
      expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined();
    });

    it('Configures with AgentObservabilityEnabled with set region', () => {
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
      process.env.AWS_REGION = 'us-west-2';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toEqual('https://xray.us-west-2.amazonaws.com/v1/traces');
      expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toEqual('https://logs.us-west-2.amazonaws.com/v1/logs');

      delete process.env.AWS_REGION;
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      process.env.AWS_DEFAULT_REGION = 'us-east-2';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toEqual('https://xray.us-east-2.amazonaws.com/v1/traces');
      expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toEqual('https://logs.us-east-2.amazonaws.com/v1/logs');
    });

    it('Does not set signal-specific endpoints when OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
      process.env.AWS_REGION = 'us-west-2';
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://my-collector:4318';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
      expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined();
    });

    it('Configures defaults when AgentObservabilityEnabled is true', () => {
      process.env.AWS_REGION = 'us-east-1';
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_TRACES_EXPORTER).toEqual('otlp');
      expect(process.env.OTEL_LOGS_EXPORTER).toEqual('otlp');
      expect(process.env.OTEL_METRICS_EXPORTER).toEqual('awsemf');
      expect(process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toEqual('true');
      expect(process.env.OTEL_TRACES_SAMPLER).toEqual('parentbased_always_on');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('fs,dns');
      expect(process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS).toEqual(
        'aws-lambda,aws-sdk,http,aws_langchain,aws_openai_agents,aws_vercel_ai'
      );
      expect(process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED).toEqual('false');
      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toEqual('https://xray.us-east-1.amazonaws.com/v1/traces');
      expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toEqual('https://logs.us-east-1.amazonaws.com/v1/logs');
    });

    it('Respects user configuration when AgentObservabilityEnabled is false', () => {
      process.env.AWS_REGION = 'us-east-1';
      delete process.env.AGENT_OBSERVABILITY_ENABLED;
      process.env.OTEL_TRACES_SAMPLER = 'traceidratio';

      setAwsDefaultEnvironmentVariables();
      expect(process.env.OTEL_TRACES_SAMPLER).toEqual('traceidratio');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('fs,dns');
      expect(process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED).toBeUndefined();
    });

    it('Respects user configuration when AgentObservabilityEnabled is true', () => {
      // Enable agent observability
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

      // Set custom values for some environment variables
      process.env.OTEL_TRACES_SAMPLER = 'traceidratio';
      process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'a,b,c,d';
      process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_TRACES_SAMPLER).toEqual('traceidratio');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('a,b,c,d');
      expect(process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED).toEqual('true');
    });
  });

  it('can load auto instrumentation from command line', () => {
    const proc: SpawnSyncReturns<Buffer> = spawnSync(
      process.execPath,
      ['--require', '../build/src/register.js', './third-party/otel/test-app/app.js'],
      {
        cwd: __dirname,
        timeout: 10000,
        killSignal: 'SIGKILL', // SIGTERM is not sufficient to terminate some hangs
        env: Object.assign({}, process.env, {
          OTEL_NODE_RESOURCE_DETECTORS: 'none',
          OTEL_TRACES_EXPORTER: 'console',
          // nx (used by lerna run) defaults `FORCE_COLOR=true`, which in
          // node v18.17.0, v20.3.0 and later results in ANSI color escapes
          // in the ConsoleSpanExporter output that is checked below.
          FORCE_COLOR: '0',

          OTEL_LOG_LEVEL: 'ALL',
          OTEL_TRACES_SAMPLER: 'always_on',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4316/v1/traces',
          OTEL_RESOURCE_ATTRIBUTES: 'service.name=test-adot-sdk-ec2-service-name',
          OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'true',
          OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'fs',
        }),
      }
    );
    assert.ifError(proc.error);
    assert.equal(proc.status, 0, `proc.status (${proc.status})`);
    assert.equal(proc.signal, null, `proc.signal (${proc.signal})`);

    assert.ok(proc.stdout.includes('AWS Distro of OpenTelemetry automatic instrumentation started successfully'));
    assert.ok(proc.stdout.includes("Environment variable OTEL_EXPORTER_OTLP_PROTOCOL is set to 'http/protobuf'"));
    assert.ok(proc.stdout.includes("Environment variable OTEL_PROPAGATORS is set to 'baggage,xray,tracecontext'"));

    // Check a span has been generated for the GET request done in app.js
    assert.ok(proc.stdout.includes("name: 'GET'"), 'console span output in stdout - validate Span Name');
    assert.ok(
      proc.stdout.includes("'service.name': 'test-adot-sdk-ec2-service-name'"),
      'console span output in stdout - validate service.name'
    );

    // eslint-disable-next-line @typescript-eslint/typedef
    const packageJson = require('./../package.json');
    const DISTRO_VERSION: string = packageJson.version;
    assert.ok(
      proc.stdout.includes(`'telemetry.auto.version': '${DISTRO_VERSION}-aws'`),
      'console span output in stdout - validate telemetry.auto.version'
    );
    assert.ok(
      proc.stdout.includes("'aws.is.local.root': true"),
      'console span output in stdout - validate aws.is.local.root'
    );
    assert.ok(
      proc.stdout.includes("'aws.local.operation': 'InternalOperation'"),
      'console span output in stdout - validate aws.local.operation'
    );
    assert.ok(
      proc.stdout.includes("'aws.local.service': 'test-adot-sdk-ec2-service-name'"),
      'console span output in stdout - validate aws.local.service'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.service': 'example.com:80'"),
      'console span output in stdout - validate aws.remote.service'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.operation': 'GET /'"),
      'console span output in stdout - validate aws.remote.operation'
    );
    assert.ok(
      proc.stdout.includes("'aws.span.kind': 'LOCAL_ROOT'"),
      'console span output in stdout - validate aws.span.kind'
    );
  });
});
// END The OpenTelemetry Authors code
