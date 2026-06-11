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
