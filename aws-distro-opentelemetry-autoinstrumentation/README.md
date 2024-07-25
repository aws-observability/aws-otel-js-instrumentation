# AWS Distro For OpenTelemetry Auto-Instrumentation

Install this package into your NodeJS project with:
```
npm install --save @aws/aws-distro-opentelemetry-autoinstrumentation
```

## Sample Environment Variables for Application Signals

```
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
export OTEL_PROPAGATORS=xray,tracecontext,b3,b3multi \
export OTEL_TRACES_EXPORTER=console,otlp \
export OTEL_TRACES_SAMPLER=always_on \
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4316/v1/traces \
export OTEL_RESOURCE_ATTRIBUTES=service.name=test-adot-sdk-ec2-service-name \
export OTEL_AWS_APPLICATION_SIGNALS_ENABLED=true \
export OTEL_NODE_DISABLED_INSTRUMENTATIONS=fs
```

## NPM Commands for ADOT JS Development

### Build TypeScript into JavaScript
```
npm run compile
```

### Lint
```
npm run lint
```

### Lint automatic fixing
```
npm run lint:fix
```
### Test this local ADOT JS package with your own local NodeJS project

In this directory, run:
```
npm install
npm run compile
npm link
```

In the target local NodeJS project to be instrumented, run

```
npm install
npm link @aws/aws-distro-opentelemetry-autoinstrumentation
```