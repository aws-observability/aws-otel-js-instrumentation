// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const OMITTED_DEPENDENCIES = [/^@ai-sdk\//, /^@langchain\//, /^@openai\/agents/, /^ai$/, /^zod$/];
const DEFAULT_TAV_TARGETS = ['@langchain/core', '@openai/agents', 'ai'];

function getInstalledPackageVersion(packageName) {
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    const packageJsonPath = path.join(searchPath, packageName, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.name === packageName && typeof packageJson.version === 'string') {
        return packageJson.version;
      }
    }
  }

  const entryPoint = require.resolve(packageName);
  let directory = path.dirname(entryPoint);
  while (directory !== path.dirname(directory)) {
    const packageJsonPath = path.join(directory, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.name === packageName && typeof packageJson.version === 'string') {
        return packageJson.version;
      }
    }
    directory = path.dirname(directory);
  }

  throw new Error(`Could not find package.json for ${packageName}`);
}

function reportCompatibilityDependency(packageName) {
  const version = getInstalledPackageVersion(packageName);
  console.log(`Testing compatibility with ${packageName}@${version}`);
  return version;
}

function registerTestInstrumentation(Instrumentation, config) {
  const {
    registerInstrumentationTesting,
    registerInstrumentationTestingProvider,
    getTestSpans,
    resetMemoryExporter,
  } = require('@opentelemetry/contrib-test-utils');
  const instrumentation = new Instrumentation(config);
  const registered = registerInstrumentationTesting(instrumentation);
  if (registered !== instrumentation) {
    instrumentation.enable();
  }
  const provider = registerInstrumentationTestingProvider();
  instrumentation.setTracerProvider(provider);
  resetMemoryExporter();
  return { getTestSpans, instrumentation, resetMemoryExporter };
}

function findSpan(spans, operationName, operationAttribute) {
  return spans.find(span => span.attributes[operationAttribute] === operationName);
}

async function verifyLangChain() {
  const { LangChainInstrumentation, INSTRUMENTATION_NAME } = require(
    '../src/instrumentation/instrumentation-langchain/instrumentation'
  );
  const { ATTR_GEN_AI_OPERATION_NAME } = require('../src/instrumentation/common/semconv');
  const { getTestSpans, resetMemoryExporter } = registerTestInstrumentation(LangChainInstrumentation);

  reportCompatibilityDependency('@langchain/core');

  const { FakeListChatModel } = require('@langchain/core/utils/testing');
  const { tool } = require('@langchain/core/tools');
  const { z } = require('zod');

  const model = new FakeListChatModel({ responses: ['Hello!'] });
  await model.invoke('Say hello');
  const chatSpan = findSpan(getTestSpans(), 'chat', ATTR_GEN_AI_OPERATION_NAME);
  assert(chatSpan, 'LangChain chat invocation did not produce a chat span');
  assert.equal(chatSpan.instrumentationScope.name, INSTRUMENTATION_NAME);

  resetMemoryExporter();
  const addTool = tool(async input => String(input.a + input.b), {
    name: 'add_numbers',
    description: 'Add two numbers',
    schema: z.object({ a: z.number(), b: z.number() }),
  });
  await addTool.invoke({ a: 1, b: 2 });
  const toolSpan = findSpan(getTestSpans(), 'execute_tool', ATTR_GEN_AI_OPERATION_NAME);
  assert(toolSpan, 'LangChain tool invocation did not produce an execute_tool span');
  assert.equal(toolSpan.instrumentationScope.name, INSTRUMENTATION_NAME);
}

async function verifyOpenAIAgents() {
  const { OpenAIAgentsInstrumentation } = require(
    '../src/instrumentation/instrumentation-openai-agents/instrumentation'
  );
  const { ATTR_GEN_AI_AGENT_NAME, ATTR_GEN_AI_OPERATION_NAME } = require('../src/instrumentation/common/semconv');
  const { getTestSpans } = registerTestInstrumentation(OpenAIAgentsInstrumentation, {
    captureMessageContent: true,
  });

  const agentsVersion = reportCompatibilityDependency('@openai/agents');
  assert.equal(getInstalledPackageVersion('@openai/agents-core'), agentsVersion);

  const { withTrace, withAgentSpan, withGenerationSpan, withFunctionSpan } = require('@openai/agents');
  await withTrace('compatibility-trace', async () => {
    await withAgentSpan(
      async () => {
        await withGenerationSpan(async () => {}, {
          data: {
            input: [{ role: 'user', content: 'Hello' }],
            output: [{ role: 'assistant', content: 'Hi!' }],
            model: 'compatibility-model',
            model_config: {},
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        });
        await withFunctionSpan(async () => {}, {
          data: {
            name: 'compatibility-tool',
            input: '{}',
            output: 'ok',
          },
        });
      },
      {
        data: {
          name: 'CompatibilityAgent',
          tools: [],
          handoffs: [],
          output_type: 'text',
        },
      }
    );
  });

  const spans = getTestSpans();
  const agentSpan = findSpan(spans, 'invoke_agent', ATTR_GEN_AI_OPERATION_NAME);
  const generationSpan = findSpan(spans, 'chat', ATTR_GEN_AI_OPERATION_NAME);
  const functionSpan = findSpan(spans, 'execute_tool', ATTR_GEN_AI_OPERATION_NAME);
  assert(agentSpan, 'OpenAI Agents invocation did not produce an invoke_agent span');
  assert.equal(agentSpan.attributes[ATTR_GEN_AI_AGENT_NAME], 'CompatibilityAgent');
  assert(generationSpan, 'OpenAI Agents generation did not produce a chat span');
  assert.equal(generationSpan.parentSpanContext?.spanId, agentSpan.spanContext().spanId);
  assert(functionSpan, 'OpenAI Agents function did not produce an execute_tool span');
  assert.equal(functionSpan.parentSpanContext?.spanId, agentSpan.spanContext().spanId);
}

function ensureVercelSpanProcessor(VercelAISpanProcessor) {
  const { trace } = require('@opentelemetry/api');
  const provider = trace.getTracerProvider();
  const delegate = provider.getDelegate?.() ?? provider;
  const processors = delegate?._registeredSpanProcessors ?? delegate?._activeSpanProcessor?._spanProcessors;
  if (Array.isArray(processors)) {
    if (!processors.some(processor => processor instanceof VercelAISpanProcessor)) {
      processors.unshift(new VercelAISpanProcessor());
    }
  } else if (typeof delegate?.addSpanProcessor === 'function') {
    delegate.addSpanProcessor(new VercelAISpanProcessor());
  }
}

async function verifyVercelAI() {
  const { SpanKind } = require('@opentelemetry/api');
  const { VercelAIInstrumentation } = require('../src/instrumentation/instrumentation-vercel-ai/instrumentation');
  const { VercelAISpanProcessor } = require('../src/instrumentation/instrumentation-vercel-ai/span-processor');
  const {
    ATTR_GEN_AI_OPERATION_NAME,
    ATTR_GEN_AI_PROVIDER_NAME,
    ATTR_GEN_AI_REQUEST_MODEL,
    ATTR_GEN_AI_USAGE_INPUT_TOKENS,
    ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  } = require('../src/instrumentation/common/semconv');
  const { getTestSpans } = registerTestInstrumentation(VercelAIInstrumentation, {
    captureMessageContent: false,
  });
  ensureVercelSpanProcessor(VercelAISpanProcessor);

  reportCompatibilityDependency('ai');
  reportCompatibilityDependency('@ai-sdk/openai');

  const { generateText } = require('ai');
  const { createOpenAI } = require('@ai-sdk/openai');
  const modelName = 'gpt-4o-mini';
  const response = {
    id: 'chatcmpl-abc123',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini-2024-07-18',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Paris is the capital of France.' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 },
  };
  const provider = createOpenAI({
    apiKey: 'sk-test1234567890abcdef1234567890abcdef1234567890abcdef',
    fetch: async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const model = typeof provider.chat === 'function' ? provider.chat(modelName) : provider(modelName);
  const result = await generateText({
    model,
    prompt: 'What is the capital of France?',
  });
  assert(result.text.includes('Paris'));

  const span = findSpan(getTestSpans(), 'chat', ATTR_GEN_AI_OPERATION_NAME);
  assert(span, 'Vercel AI invocation did not produce a chat span');
  assert.equal(span.kind, SpanKind.CLIENT);
  assert.equal(span.attributes[ATTR_GEN_AI_PROVIDER_NAME], 'openai');
  assert.equal(span.attributes[ATTR_GEN_AI_REQUEST_MODEL], modelName);
  assert.equal(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS], 18);
  assert.equal(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS], 8);
}

async function verifyCompatibility(target) {
  process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = 'false';
  require('ts-node/register/transpile-only');

  if (target === '@langchain/core') {
    await verifyLangChain();
  } else if (target === '@openai/agents') {
    await verifyOpenAIAgents();
  } else if (target === 'ai') {
    await verifyVercelAI();
  } else {
    throw new Error(`Unknown compatibility target: ${target}`);
  }
  console.log(`Verified ${target} instrumentation compatibility`);
}

function runNpm(args, cwd, env = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error('npm_execpath is not set; run this script through npm');
  }

  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function shouldCopy(source) {
  const relative = path.relative(PACKAGE_ROOT, source);
  if (!relative) return true;

  return !relative
    .split(path.sep)
    .some(segment => segment === 'node_modules' || segment === 'build' || segment === 'coverage');
}

function removeCompatibilityDependencies(dependencies = {}) {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => !OMITTED_DEPENDENCIES.some(pattern => pattern.test(name)))
  );
}

function runTarget(target) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adot-js-tav-'));
  console.log(`Running ${target} compatibility tests in ${tempRoot}`);

  try {
    fs.cpSync(PACKAGE_ROOT, tempRoot, {
      recursive: true,
      filter: shouldCopy,
    });

    const packageJsonPath = path.join(tempRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    packageJson.dependencies = removeCompatibilityDependencies(packageJson.dependencies);
    packageJson.devDependencies = removeCompatibilityDependencies(packageJson.devDependencies);
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    runNpm(['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'], tempRoot);
    runNpm(['run', 'create-version'], tempRoot);
    runNpm(['run', 'test-all-versions:isolated'], tempRoot, { TAV: target });
  } finally {
    if (process.env.KEEP_TAV_TMP === '1') {
      console.log(`Keeping dependency compatibility workspace at ${tempRoot}`);
    } else {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

const targets = process.env.TAV ? process.env.TAV.split(',').map(target => target.trim()) : DEFAULT_TAV_TARGETS;

async function main() {
  if (process.argv[2] === 'verify') {
    await verifyCompatibility(process.argv[3]);
    return;
  }

  for (const target of targets.filter(Boolean)) {
    runTarget(target);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
