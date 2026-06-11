// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const express = require('express');
const { processData, validateInput, computeResult, busyWait, asyncValidate, ValueError } = require('./helpers');

const app = express();
const PORT = 8080;

app.use(express.json());

// --- Health endpoint ---
app.get('/health', (req, res) => {
  res.send('Ready');
});

// --- Success endpoint (200) ---
app.get('/success', (req, res) => {
  const result = processData('test_data');
  computeResult(42);
  res.json({ status: 'ok', result });
});

// --- Error endpoint (400) ---
app.get('/error', (req, res) => {
  res.status(400).json({ error: 'bad request' });
});

// --- Error-status endpoint (500, NO throw) ---
// Exercises the incident-snapshot `error_status` trigger: server-error status
// without an exception in flight. Distinct from /fault which throws.
app.get('/error-status', (req, res) => {
  res.status(500).json({ err: 'server decided — no throw' });
});

// --- Path-param endpoint that returns 500 WITHOUT throwing ---
// Drives `request_context.path_params` capture in incident snapshots.
// Non-throwing path is required: when a handler throws, Express's router
// pops the matched-route layer before the response is sent, which wipes
// `req.params` — so by res.end time there's nothing left to snapshot.
// A res.status(500).json(...) path keeps the route layer on the stack until
// the response is fully sent, so req.params stays populated.
app.get('/users/:id/throw', (req, res) => {
  res.status(500).json({ err: 'forced 500 with id=' + req.params.id });
});

// --- Async-exception endpoint ---
// async handler + async helper that rejects. Drives `call_path[].is_async=true`.
app.get('/async-exception', async (req, res, next) => {
  try {
    await asyncValidate(null);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Fault endpoint (500 via thrown RuntimeError) ---
app.get('/fault', (req, res) => {
  throw new RuntimeError('Intentional server fault');
});

// --- Exception endpoint (500 via ValueError) ---
app.get('/exception', (req, res, next) => {
  try {
    validateInput(null);
  } catch (err) {
    next(err);
  }
});

// --- Slow endpoint (> 5s response) ---
// The busy-wait lives in helpers.js so the AST instrumentation (which only
// transforms require()'d modules, not the entry script) records it in the
// incident snapshot's call_path.
app.get('/slow', (req, res) => {
  const elapsed = busyWait(6000);
  res.json({ elapsed, message: 'Slow operation completed' });
});

// --- Data endpoint (POST, accepts JSON body) ---
// When the body contains { "forceError": true } the handler throws — used by
// the incident-snapshot payload-capture test to assert that request_body and
// request_headers are both recorded on the snapshot.
app.post('/data', (req, res) => {
  const body = req.body || {};
  if (body.forceError) {
    throw new RuntimeError('forced from /data body');
  }
  const result = processData(JSON.stringify(body));
  res.json({ received: true, result });
});

/**
 * Custom error class to mirror Python's RuntimeError.
 */
class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeError';
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Ready`);
  console.log(`Express ServiceEvents contract test app listening on port ${PORT}`);
});
