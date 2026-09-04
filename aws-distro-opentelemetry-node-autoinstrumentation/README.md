# AWS Distro for OpenTelemetry (ADOT) NodeJS Auto-Instrumentation

Install this package into your NodeJS project with:

```shell
npm install --save @aws/aws-distro-opentelemetry-node-autoinstrumentation
```

Run your application with ADOT NodeJS with:

```shell
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' your-application.js
```

## Generative AI

Instrumentation is also available for the supported agent frameworks and SDKs
listed below. These libraries complement the auto-instrumentation already
included with the distribution, providing comprehensive, end-to-end visibility
into your agent applications, from incoming requests and framework orchestration
to model calls, tool invocations, and downstream dependencies.

- [LangChain](src/instrumentation/instrumentation-langchain/README.md) (`@langchain/core >=1.0.0 <2.0.0`)
- [OpenAI Agents SDK](src/instrumentation/instrumentation-openai-agents/README.md) (`@openai/agents-core >=0.1.0`)
- [Vercel AI SDK](src/instrumentation/instrumentation-vercel-ai/README.md) (`ai >=3.3.0 <7.0.0`)

> [!NOTE]
> When agent observability is enabled (`AGENT_OBSERVABILITY_ENABLED=true`),
> instrumentation is skipped when a conflicting third-party instrumentation is
> detected for the same framework. You may add `aws_langchain`,
> `aws_openai_agents`, and `aws_vercel_ai` to
> `OTEL_NODE_DISABLED_INSTRUMENTATIONS` to disable all of the above
> instrumentations if you are using another instrumentation source and automatic
> detection does not work. If another third-party instrumentation is installed,
> you may set `AWS_AGENTIC_INSTRUMENTATION_OPT_IN=true` to force the above
> instrumentations to load. We recommend that you do not use this setting because
> both instrumentations may run and produce duplicate or inconsistent telemetry.

## Sample Environment Variables for Application Signals

```shell
export OTEL_RESOURCE_ATTRIBUTES=service.name=example-application-service-name
export OTEL_AWS_APPLICATION_SIGNALS_ENABLED=true
export OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT=http://localhost:4316/v1/metrics
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4316/v1/traces
export OTEL_TRACES_EXPORTER=console,otlp
export OTEL_TRACES_SAMPLER=xray
export OTEL_TRACES_SAMPLER_ARG=endpoint=http://localhost:2000,polling_interval=300
```

### General Recommendations

| Environment Variable | Description | Example |
| -------------------- | ----------- | ------- |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Leave unset so that ADOT JS will use a recommended OTLP protocol | `http/protobuf` |
| `OTEL_PROPAGATORS` | Leave unset so that ADOT JS will use a recommended list of propagators | `baggage,xray,tracecontext` |
| `OTEL_NODE_DISABLED_INSTRUMENTATIONS` | Leave unset so that ADOT JS will disable a recommended list of instrumentations | `fs,dns` |
| `OTEL_NODE_RESOURCE_DETECTORS` | Leave unset so that ADOT JS will use a recommended list of Resource Detectors. If set, `env` should be at the end of the list | `aws,env` |
