# Changelog

All notable changes to this project will be documented in this file.

> **Note:** This CHANGELOG was created starting after version 0.7.0. Earlier changes are not documented here.

For any change that affects end users of this package, please add an entry under the **Unreleased** section. Briefly summarize the change and provide the link to the PR. Example:

- add GenAI attribute support for Amazon Bedrock models
  ([#111](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/111))

If your change does not need a CHANGELOG entry, add the "skip changelog" label to your PR.

## Unreleased

### Breaking Changes

- Update minimum Node.js version requirement from 14 to 18, aligning with upstream OpenTelemetry JS support
  ([#312](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/312))
- Upgrade OpenTelemetry dependencies to 2.x (core packages 2.5.0, experimental packages 0.211.0)
  ([#314](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/314))
  ([#315](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/347))

### Enhancements

- Add Service and Environment dimensions to EMF metrics when `OTEL_METRICS_ADD_APPLICATION_SIGNALS_DIMENSIONS` is enabled.
  Supports platform-aware environment defaults (Lambda, EC2, ECS, EKS).
  ([#299](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/299))

### Maintenance

- Update AWS SDK to 3.982.0 to fix @smithy/config-resolver vulnerability (GHSA-6475-r3vj-m8vf) and CVE-2026-0994
  ([#312](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/312))
  ([#346](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/346))

### Bugfixes

- Fix Lambda layer AWS SDK instrumentation not working after OTel 2.x upgrade by externalizing require-in-the-middle from webpack bundle
  ([#349](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/349))
- Fix UDP exporter e2e test by updating sample app to OTel 2.x dependencies
  ([#350](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/350))

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
