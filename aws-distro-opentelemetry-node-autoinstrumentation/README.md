# AWS Distro for OpenTelemetry (ADOT) NodeJS Auto-Instrumentation

Install this package into your NodeJS project with:

```shell
npm install --save @aws/aws-distro-opentelemetry-node-autoinstrumentation
```

Run your application with ADOT NodeJS with:

```shell
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' your-application.js
```

## Sample Environment Variables for Application Signals

```shell
export OTEL_AWS_APPLICATION_SIGNALS_ENABLED=true \
export OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT=http://localhost:4316/v1/metrics \
export OTEL_PROPAGATORS=xray,tracecontext,b3,b3multi \
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4316/v1/traces \
export OTEL_TRACES_EXPORTER=console,otlp \
export OTEL_TRACES_SAMPLER=xray \
export OTEL_TRACES_SAMPLER_ARG=endpoint=http://localhost:2000,polling_interval=300 \
export OTEL_RESOURCE_ATTRIBUTES=service.name=test-adot-sdk-ec2-service-name \
export OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs
```
