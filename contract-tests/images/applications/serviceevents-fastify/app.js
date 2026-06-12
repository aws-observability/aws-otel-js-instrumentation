// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Fastify app for the serviceevents contract tests. Routes mirror serviceevents-express
// so the shared ServiceEventsContractTestBase suite can run unchanged.
const fastify = require('fastify')({ logger: false });
const { processData, validateInput, computeResult, busyWait, asyncValidate, ValueError } = require('./helpers');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const HOST = '0.0.0.0';

class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeError';
  }
}

// --- Health ---
fastify.get('/health', async () => ({ status: 'ok' }));

// --- Success (200) ---
fastify.get('/success', async () => {
  const result = processData('test_data');
  computeResult(42);
  return { status: 'ok', result };
});

// --- Error (400) ---
fastify.get('/error', async (request, reply) => {
  reply.code(400);
  return { error: 'bad request' };
});

// --- Error-status (500, NO throw) — exercises error_status trigger ---
fastify.get('/error-status', async (request, reply) => {
  reply.code(500);
  return { err: 'server decided — no throw' };
});

// --- Fault (500 via thrown RuntimeError) ---
fastify.get('/fault', async () => {
  throw new RuntimeError('Intentional server fault');
});

// --- Exception (500 via thrown ValueError inside validateInput) ---
fastify.get('/exception', async () => {
  validateInput(null);
  return { unreachable: true };
});

// --- Path-param route that returns 500 WITHOUT throwing ---
// Non-throwing path preserves `request.params` through response-end so
// the Express-derived path_params capture works for this framework too.
fastify.get('/users/:id/throw', async (request, reply) => {
  reply.code(500);
  return { err: 'forced 500 with id=' + request.params.id };
});

// --- Slow (> 5s) — drives timeout trigger ---
fastify.get('/slow', async () => {
  const elapsed = busyWait(6000);
  return { elapsed, message: 'Slow operation completed' };
});

// --- Data (POST, JSON body) — drives request_body capture when forceError=true ---
fastify.post('/data', async request => {
  const body = request.body || {};
  if (body.forceError) {
    throw new RuntimeError('forced from /data body');
  }
  const result = processData(JSON.stringify(body));
  return { received: true, result };
});

// --- Async exception (awaits an async helper that throws) ---
fastify.get('/async-exception', async () => {
  await asyncValidate(null);
  return { unreachable: true };
});

// No custom setErrorHandler — Fastify's default formats errors as JSON with
// the right status code, and leaving the default in place keeps the ServiceEvents
// Fastify `onError` hook as the first observer of thrown errors.

fastify.listen({ host: HOST, port: PORT }, err => {
  if (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('Ready');
  // eslint-disable-next-line no-console
  console.log(`Fastify ServiceEvents contract test app listening on port ${PORT}`);
});
