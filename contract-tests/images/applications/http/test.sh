export OTEL_METRIC_EXPORT_INTERVAL=1000
export OTEL_AWS_APPLICATION_SIGNALS_ENABLED=true
export OTEL_METRICS_EXPORTER=none
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_BSP_SCHEDULE_DELAY=1
export OTEL_TRACES_SAMPLER=always_on
export OTEL_RESOURCE_ATTRIBUTES=service.name=test

node --require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register server.js
