// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Simulated Lambda application for lite SDK e2e testing.
//
// Exposes an HTTP server that simulates Lambda invocations. Each request to
// /invoke runs a handler that creates spans similar to a real Lambda invocation
// (a SERVER span for the handler and a child CLIENT span for an AWS SDK call),
// then force-flushes the tracer provider so the lite SDK exports the batch over
// UDP to the mock collector. Mirrors the Python contract test's
// lambda_function.py, adapted to the Node.js OpenTelemetry API.
//
// The lite SDK itself is bootstrapped by the layer's wrapper via
// `--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register`
// with AWS_LAMBDA_LITE_MODE=true (see the Dockerfile CMD), so this file only
// produces spans through the public OpenTelemetry API.

const http = require('http');
const url = require('url');
const { trace, context, SpanKind, SpanStatusCode } = require('@opentelemetry/api');

const _PORT = 8080;

function invokeHandler() {
  const tracer = trace.getTracer('opentelemetry.instrumentation.aws_lambda', '0.1.0');

  return tracer.startActiveSpan('my-function.handler', { kind: SpanKind.SERVER }, serverSpan => {
    serverSpan.setAttribute('faas.invocation_id', `req-${process.hrtime.bigint()}`);
    serverSpan.setAttribute('cloud.resource_id', 'arn:aws:lambda:us-west-2:123456789012:function:my-function');

    const botocoreTracer = trace.getTracer('opentelemetry.instrumentation.aws-sdk', '0.2.0');
    const clientSpan = botocoreTracer.startSpan(
      'S3.ListBuckets',
      { kind: SpanKind.CLIENT },
      trace.setSpan(context.active(), serverSpan)
    );
    clientSpan.setAttribute('rpc.service', 'S3');
    clientSpan.setAttribute('rpc.system', 'aws-api');
    clientSpan.setAttribute('rpc.method', 'ListBuckets');
    clientSpan.setAttribute('http.status_code', 200);
    clientSpan.setStatus({ code: SpanStatusCode.OK });
    clientSpan.end();

    serverSpan.setStatus({ code: SpanStatusCode.OK });
    serverSpan.end();
    return { statusCode: 200, body: 'ok' };
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url);

  if (parsedUrl.pathname === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  if (parsedUrl.pathname === '/invoke') {
    const result = invokeHandler();

    // Force-flush so the lite SDK exports the buffered spans over UDP, the same
    // way the Lambda runtime flushes at the end of an invocation.
    //
    // trace.getTracerProvider() returns a ProxyTracerProvider, which has no
    // forceFlush(); the real lite TracerProvider is its delegate. Unwrap it.
    let provider = trace.getTracerProvider();
    if (provider && typeof provider.getDelegate === 'function') {
      provider = provider.getDelegate();
    }
    if (provider && typeof provider.forceFlush === 'function') {
      await provider.forceFlush();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(_PORT, '0.0.0.0', () => {
  console.log('Server is listening on port', _PORT);
  console.log('Ready');
});
