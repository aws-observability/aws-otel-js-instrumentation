# AWS Distro for OpenTelemetry - Instrumentation for JavaScript

## Introduction

This project is a redistribution of the [OpenTelemetry Auto-Instrumentation for NodeJS](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/metapackages/auto-instrumentations-node),
preconfigured for use with AWS services. Please check out that project too to get a better
understanding of the underlying internals. You won't see much code in this repository since we only
apply some small configuration changes, and our OpenTelemetry friends takes care of the rest. The
exception to this is support for Application Signals.

We provided a NodeJS agent that can be attached to any application using a supported NodeJS version and dynamically injects
bytecode to capture telemetry from a number of popular libraries and frameworks. The telemetry data
can be exported in a variety of formats. In addition, the agent and exporter can be configured via
command line arguments or environment variables. The net result is the ability to gather telemetry
data from a NodeJS application without any code changes.

## Getting Started

The official AWS Documentation for getting started with ADOT JS Auto-Instrumentation is under construction.
Meanwhile, check out the [getting started documentation for manual instrumentation](https://aws-otel.github.io/docs/getting-started/javascript-sdk).

## Supported NodeJS libraries and frameworks

For the complete list of supported frameworks, please refer to the [OpenTelemetry for JavaScript documentation](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/metapackages/auto-instrumentations-node#supported-instrumentations).

## Generative AI

As of version `0.13.0`, this distribution officially supports Generative AI
instrumentation for the following frameworks and SDKs:

- [LangChain](https://github.com/aws-observability/aws-otel-js-instrumentation/blob/main/aws-distro-opentelemetry-node-autoinstrumentation/src/instrumentation/instrumentation-langchain/README.md) (`@langchain/core >= 1.0.0, < 2.0.0`)
- [OpenAI Agents SDK](https://github.com/aws-observability/aws-otel-js-instrumentation/blob/main/aws-distro-opentelemetry-node-autoinstrumentation/src/instrumentation/instrumentation-openai-agents/README.md) (`@openai/agents-core >= 0.1.0`)
- [Vercel AI SDK](https://github.com/aws-observability/aws-otel-js-instrumentation/blob/main/aws-distro-opentelemetry-node-autoinstrumentation/src/instrumentation/instrumentation-vercel-ai/README.md) (`ai >= 3.3.0, < 7.0.0`)

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
        <pre><code>OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_PROPAGATORS=baggage,xray,tracecontext
OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs,dns
OTEL_NODE_ENABLED_INSTRUMENTATIONS=aws-lambda,aws-sdk,http,undici,aws_langchain,aws_openai_agents,aws_vercel_ai
OTEL_TRACES_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=awsemf
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
OTEL_TRACES_SAMPLER=parentbased_always_on
OTEL_AWS_APPLICATION_SIGNALS_ENABLED=false
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://xray.&lt;region&gt;.amazonaws.com/v1/traces
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://logs.&lt;region&gt;.amazonaws.com/v1/logs</code></pre>
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
        <pre><code>export AWS_REDACT_SPAN_ATTRIBUTES='gen_ai.input.messages,gen_ai.output.messages'</code></pre>
        <p>To redact multiple attributes matching a pattern:</p>
        <pre><code>export AWS_REDACT_SPAN_ATTRIBUTES='gen_ai.*.messages'</code></pre>
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
        <pre><code>export OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs,dns,aws_langchain,aws_openai_agents,aws_vercel_ai</code></pre>
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

## Dynamic Instrumentation

Dynamic Instrumentation lets you capture runtime "snapshots" (local variables and trace context, plus the call stack when `CaptureStackTrace` is enabled in the configuration) from a running application on demand — without redeploying or restarting it. The SDK periodically polls instrumentation configurations from the AWS control plane (proxied through the CloudWatch Agent), applies them at runtime using the V8 Inspector in an isolated worker thread, and emits captured snapshots as OTLP logs.

JS Dynamic Instrumentation is line-level: snapshots are captured at a specific line, and variables are selected via `CaptureLocals`. Function arguments are part of V8's local scope, so to capture an argument, list its name in `CaptureLocals` (only the innermost function's parameters and locals are visible at the breakpoint line). Stack trace capture is off by default; enable it per-configuration with `CaptureStackTrace: true`.

This feature is **disabled by default** and is **not active in AWS Lambda**. It is opt-in via environment variables:

| Environment Variable | Default | Description |
| --- | --- | --- |
| `OTEL_AWS_DYNAMIC_INSTRUMENTATION_ENABLED` | `false` | Set to `true` to enable Dynamic Instrumentation. |
| `OTEL_AWS_DYNAMIC_INSTRUMENTATION_API_URL` | `http://localhost:2000` | Control plane endpoint, proxied by the CloudWatch Agent. |
| `OTEL_AWS_DYNAMIC_INSTRUMENTATION_BREAKPOINT_POLL_INTERVAL` | `60` | Seconds between breakpoint configuration polls (range: 5–86400). |
| `OTEL_AWS_DYNAMIC_INSTRUMENTATION_PROBE_POLL_INTERVAL` | `600` | Seconds between probe configuration polls (range: 5–86400). |
| `OTEL_AWS_DYNAMIC_INSTRUMENTATION_OUTPUT_DIRECTORY` | `aws-di-snapshots` | Directory for snapshot output. |
| `OTEL_AWS_OTLP_LOGS_ENDPOINT` | `http://localhost:4316/v1/logs` | OTLP/HTTP endpoint that captured snapshots are exported to as log records. |

## Support

Please note that as per policy, we're providing support via GitHub on a best effort basis. However, if you have AWS Enterprise Support you can create a ticket and we will provide direct support within the respective SLAs.

## Security issue notifications

If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.

## License

This project is licensed under the Apache-2.0 License.

## Notices

### NodeJS Version Support

This project ensures compatibility with the following supported NodeJS versions: 18, 20, 22, 24

### Note on Amazon CloudWatch Application Signals

[Amazon CloudWatch Application Signals](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Monitoring-Sections.html) components are designed to seamlessly work with all library instrumentations offered by [OpenTelemetry NodeJS auto-instrumentation](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/metapackages/auto-instrumentations-node/README.md). While upstream OpenTelemetry NodeJS instrumentations are in beta, Application Signals components are stable, production ready and have also been tested for popular libraries/frameworks such as `ExpressJS, AWS SDK for JavaScript V3, and others`. We will prioritize backward compatibility for Application Signals components, striving to ensure that they remain functional even in the face of potential breaking changes introduced by OpenTelemetry upstream libraries. Please [raise an issue](https://github.com/aws-observability/aws-otel-js-instrumentation/blob/main/CONTRIBUTING.md#reporting-bugsfeature-requests) if you notice Application Signals doesn't work for a particular OpenTelemetry supported library.

## Checksum Verification

Artifacts released will include a `.sha256` file for checksum verification starting from v0.4.0
To verify, run the command `shasum -a 256 -c <artifact_name>.sha256`
It should return the output `<artifact_name>: OK` if the validation is successful
