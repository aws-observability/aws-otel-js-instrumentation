# AWS Distro for OpenTelemetry OpenAI Agents Instrumentation

This instrumentation traces applications built with the OpenAI Agents SDK for
JavaScript and emits telemetry that follows OpenTelemetry's Generative AI
semantic conventions.

## Features

- Creates spans for agents, model generations, tools, guardrails, and handoffs.
- Records model, token usage, message, tool, and operation attributes when they
  are available from the Agents SDK.
- Supports CommonJS and ECMAScript modules.

## Installation

Install the ADOT Node.js auto-instrumentation package and the OpenAI Agents SDK:

```shell
npm install @aws/aws-distro-opentelemetry-node-autoinstrumentation @openai/agents
```

## Usage

The instrumentation is registered with ADOT Node.js auto-instrumentation and is
loaded when the OpenAI Agents SDK is installed:

```shell
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' app.js
```

No application tracing code or Agents SDK trace processor registration is
required.

## Disable the instrumentation

Add `aws_openai_agents` to `OTEL_NODE_DISABLED_INSTRUMENTATIONS` before starting
the application. Include any other disabled instrumentations in the same
comma-separated value:

```shell
export OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs,dns,aws_openai_agents
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' app.js
```

If `OTEL_NODE_ENABLED_INSTRUMENTATIONS` is set, omitting `aws_openai_agents` from
its comma-separated allowlist also disables this instrumentation.

## Supported versions

- `@openai/agents-core`: `>=0.1.0`

## References

- [OpenTelemetry generative AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenAI Agents SDK for JavaScript](https://openai.github.io/openai-agents-js/)
