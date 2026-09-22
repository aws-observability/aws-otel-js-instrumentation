# AWS Distro for OpenTelemetry LangChain Instrumentation

This instrumentation traces applications built with LangChain.js and emits
telemetry that follows OpenTelemetry's Generative AI semantic conventions.

## Features

- Creates spans for chains, agents, model calls, and tools.
- Records model, token usage, message, tool, and operation attributes when they
  are available from LangChain callbacks.
- Supports CommonJS and ECMAScript modules.

## Installation

Install the ADOT Node.js auto-instrumentation package and a supported LangChain
core version:

```shell
npm install @aws/aws-distro-opentelemetry-node-autoinstrumentation "@langchain/core@^1"
```

## Usage

The instrumentation is registered with ADOT Node.js auto-instrumentation and is
loaded when LangChain is installed:

```shell
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' app.js
```

No application tracing code or LangChain callback registration is required.

## Disable the instrumentation

Add `aws_langchain` to `OTEL_NODE_DISABLED_INSTRUMENTATIONS` before starting the
application. Include any other disabled instrumentations in the same
comma-separated value:

```shell
export OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs,dns,aws_langchain
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' app.js
```

If `OTEL_NODE_ENABLED_INSTRUMENTATIONS` is set, omitting `aws_langchain` from its
comma-separated allowlist also disables this instrumentation.

## Supported versions

- `@langchain/core`: `>=1.0.0 <2.0.0`

## References

- [OpenTelemetry generative AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [LangChain.js documentation](https://docs.langchain.com/oss/javascript/langchain/overview)
