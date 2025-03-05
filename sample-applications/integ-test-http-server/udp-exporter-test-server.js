'use strict';

const { trace, SpanKind, context } = require('@opentelemetry/api');
const { AlwaysOnSampler } = require('@opentelemetry/sdk-trace-node');
const express = require('express');
const process = require('process');
const opentelemetry = require("@opentelemetry/sdk-node");
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { AWSXRayPropagator } = require("@opentelemetry/propagator-aws-xray");
const { AWSXRayIdGenerator } = require("@opentelemetry/id-generator-aws-xray");
const { OTLPUdpSpanExporter } = require("@aws/aws-otel-otlp-udp-exporter")

const _traceExporter = new OTLPUdpSpanExporter();
const _spanProcessor = new SimpleSpanProcessor(_traceExporter);

const PORT = parseInt(process.env.SAMPLE_APP_PORT || '8080', 10);
const app = express();

app.get('/', (req, res) => {
  res.send(`healthcheck`)
});

app.get('/test', (req, res) => {
  const tracer = trace.getTracer("testTracer");
  let ctx = context.active();
  let span = tracer.startSpan("testSpan", {kind: SpanKind.SERVER}, ctx);
  let traceId = span.spanContext().traceId;
  span.end();
  let xrayFormatTraceId = "1-" + traceId.substring(0,8) + "-" + traceId.substring(8);
  console.log(`X-Ray Trace ID is: ${xrayFormatTraceId}`);

  res.send(`${xrayFormatTraceId}`);
});

app.listen(PORT, async () => {
  await nodeSDKBuilder();
  console.log(`Listening for requests on http://localhost:${PORT}`);
});

async function nodeSDKBuilder() {
  const sdk = new opentelemetry.NodeSDK({
      textMapPropagator: new AWSXRayPropagator(),
      instrumentations: [],
      spanProcessor: _spanProcessor,
      sampler: new AlwaysOnSampler(),
      idGenerator: new AWSXRayIdGenerator(),
  });

  // this enables the API to record telemetry
  await sdk.start();

  // gracefully shut down the SDK on process exit
  process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('Tracing terminated'))
    .catch((error) => console.log('Error terminating tracing', error))
    .finally(() => process.exit(0));
  });
}
