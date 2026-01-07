# Changelog

All notable changes to this project will be documented in this file.

> **Note:** This CHANGELOG was created starting after version 0.7.0. Earlier changes are not documented here.

For any change that affects end users of this package, please add an entry under the **Unreleased** section. Briefly summarize the change and provide the link to the PR. Example:

- add GenAI attribute support for Amazon Bedrock models
  ([#111](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/111))

If your change does not need a CHANGELOG entry, add the "skip changelog" label to your PR.

## Unreleased

### Enhancements

- Add Service and Environment dimensions to EMF metrics when `OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS` is enabled.
  Supports platform-aware environment defaults (Lambda, EC2, ECS, EKS).
  ([#299](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/299))

## v0.8.1 - 2025-12-17

### Bugfixes

- Fix issue where UDP Exporter throws error in async callback, which isn't caught
  ([#289](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/259))

## v0.8.0 - 2025-10-08

### Enhancements

- Support X-Ray Trace Id extraction from Lambda Context object, and respect user-configured OTEL_PROPAGATORS in AWS Lamdba instrumentation
  ([#259](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/259))

### Bugfixes

- Fix issue where UDP Exporter throws error in async callback, which isn't caught
  ([#289](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/259))
