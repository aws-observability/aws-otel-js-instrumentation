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

As of version `0.13.0`, this distribution officially supports Generative AI
instrumentation for the following frameworks and SDKs:

- [LangChain](src/instrumentation/instrumentation-langchain/README.md) (`@langchain/core >= 1.0.0, < 2.0.0`)
- [OpenAI Agents SDK](src/instrumentation/instrumentation-openai-agents/README.md) (`@openai/agents-core >= 0.1.0`)
- [Vercel AI SDK](src/instrumentation/instrumentation-vercel-ai/README.md) (`ai >= 3.3.0, < 7.0.0`)

These instrumentations provide end-to-end visibility into agent applications,
including framework orchestration, model calls, tool invocations, and downstream
dependencies.

### Configuration

<table>
  <thead>
    <tr>
      <th>Environment variable</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>AGENT_OBSERVABILITY_ENABLED</code></td>
      <td>
        <p>Set to <code>true</code> to enable agent-observability defaults. The default is <code>false</code>.</p>
        <p>When enabled, the following environment variable defaults are applied unless you have already configured them:</p>
        <p><code>OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf<br>
OTEL_PROPAGATORS=baggage,<wbr>xray,<wbr>tracecontext<br>
OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs,<wbr>dns<br>
OTEL_NODE_ENABLED_INSTRUMENTATIONS=aws-lambda,<wbr>aws-sdk,<wbr>http,<wbr>undici,<wbr>aws_langchain,<wbr>aws_openai_agents,<wbr>aws_vercel_ai<br>
OTEL_TRACES_EXPORTER=otlp<br>
OTEL_LOGS_EXPORTER=otlp<br>
OTEL_METRICS_EXPORTER=awsemf<br>
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true<br>
OTEL_TRACES_SAMPLER=parentbased_always_on<br>
OTEL_AWS_APPLICATION_SIGNALS_ENABLED=false<br>
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://xray.&lt;region&gt;.amazonaws.com/v1/traces<br>
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://logs.&lt;region&gt;.amazonaws.com/v1/logs</code></p>
        <blockquote>
          <p>[!NOTE]</p>
          <p>The trace and log endpoints are configured only when <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> is not set and an AWS Region can be determined.</p>
        </blockquote>
        <br>
      </td>
    </tr>
    <tr>
      <td><code>AWS_REDACT_SPAN_ATTRIBUTES</code></td>
      <td>
        <p>Your spans may contain sensitive information from LLM interactions, such as your users' prompt data and tool call information; use <code>AWS_REDACT_SPAN_ATTRIBUTES</code> to specify a comma-separated list of span attributes to redact. Matching values in spans, span events, and span links are all replaced with <code>REDACTED</code>. Note that this applies to all span attributes, not just those produced by this distribution's instrumentations.</p>
        <p>Supports wildcard patterns.</p>
        <p><strong>Examples:</strong></p>
        <p>To redact specific sensitive data GenAI attributes:</p>
        <p><code>export AWS_REDACT_SPAN_ATTRIBUTES='gen_ai.input.messages,<wbr>gen_ai.output.messages'</code></p>
        <p>To redact multiple attributes matching a pattern:</p>
        <p><code>export AWS_REDACT_SPAN_ATTRIBUTES='gen_ai.*.messages'</code></p>
        <blockquote>
          <p>[!WARNING]</p>
          <p>Redaction occurs in-process within the agent, before telemetry is exported. This may affect other integrations that rely on these attribute values.</p>
        </blockquote>
        <br>
      </td>
    </tr>
    <tr>
      <td><code>OTEL_NODE_DISABLED_INSTRUMENTATIONS</code></td>
      <td>
        <p>Add <code>aws_langchain</code>, <code>aws_openai_agents</code>, or <code>aws_vercel_ai</code> to the comma-separated value to force-disable individual instrumentations. To force-disable all three:</p>
        <p><code>export OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs,<wbr>dns,<wbr>aws_langchain,<wbr>aws_openai_agents,<wbr>aws_vercel_ai</code></p>
        <blockquote>
          <p>[!NOTE]</p>
          <p>An instrumentation is skipped when a conflicting third-party instrumentation is detected for the same framework.</p>
          <p>You may use <code>OTEL_NODE_DISABLED_INSTRUMENTATIONS</code> to force-disable the corresponding instrumentation if you are using another instrumentation source and automatic detection does not work. If another third-party instrumentation is installed, you should uninstall it or otherwise resolve any dependency conflicts before using the above instrumentations.</p>
        </blockquote>
        <br>
      </td>
    </tr>
  </tbody>
</table>

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
