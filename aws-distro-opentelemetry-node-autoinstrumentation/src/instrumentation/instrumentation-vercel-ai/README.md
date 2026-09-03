# AWS Distro for OpenTelemetry Vercel AI SDK instrumentation

This instrumentation traces applications built with the Vercel AI SDK and emits
telemetry that follows OpenTelemetry's Generative AI semantic conventions.

## Features

- Enables telemetry for `generateText`, `streamText`, `generateObject`, and
  `streamObject` unless a call explicitly disables it.
- Translates Vercel AI SDK spans to OpenTelemetry generative AI attributes.
- Records prompt and response content when content capture is enabled.
- Supports CommonJS and ECMAScript modules.

## Installation

Install the ADOT Node.js auto-instrumentation package and a supported Vercel AI
SDK version:

```shell
npm install @aws/aws-distro-opentelemetry-node-autoinstrumentation "ai@>=3.3.0 <7"
```

## Usage

The instrumentation is registered with ADOT Node.js auto-instrumentation and is
loaded when the Vercel AI SDK is installed:

```shell
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' app.js
```

No application tracing code is required.

## Disable the instrumentation

Add `aws_vercel_ai` to `OTEL_NODE_DISABLED_INSTRUMENTATIONS` before starting the
application. Include any other disabled instrumentations in the same
comma-separated value:

```shell
export OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs,dns,aws_vercel_ai
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' app.js
```

If `OTEL_NODE_ENABLED_INSTRUMENTATIONS` is set, omitting `aws_vercel_ai` from its
comma-separated allowlist also disables this instrumentation.

## Supported versions

- `ai`: `>=3.3.0 <7.0.0`

## References

- [OpenTelemetry generative AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Vercel AI SDK telemetry documentation](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
