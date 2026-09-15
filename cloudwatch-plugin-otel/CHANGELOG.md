# Release History: @aws/cloudwatch-plugin-otel

## Unreleased

* Added derived metric dimensions for dependency-edge (topology) metrics: additional messaging keys (`messaging.operation.type`, `messaging.consumer.group.name`), peer (`server.address`, `server.port`), GenAI (`gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.operation.name`), AWS resource identity (`aws.s3.bucket`, `aws.dynamodb.table_names`, `aws.lambda.invoked_arn`, `aws.sns.topic.arn`, `aws.sqs.queue.url`), and FaaS (`faas.invoked_name`, `faas.invoked_provider`, `faas.invoked_region`, `faas.trigger`) semantic-convention attributes, copied from the span when present ([#557](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/557))

## v0.1.0 - 2026-08-25

* Initial release: in-process span-derived RED metrics for the OpenTelemetry JS SDK ([#520](https://github.com/aws-observability/aws-otel-js-instrumentation/pull/520))
