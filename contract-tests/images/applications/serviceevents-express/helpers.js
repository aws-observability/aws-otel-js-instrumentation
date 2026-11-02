// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helper functions for serviceevents Express contract test.
 *
 * These are in a separate module so that the AST instrumentation hooks
 * can transform them properly. Functions call each other to test
 * nested function call tracking.
 */

function formatResponse(data) {
  return {
    formatted: true,
    payload: data,
    timestamp: new Date().toISOString(),
  };
}

function validateInput(value) {
  if (!value) {
    throw new ValueError('Invalid input');
  }
  return true;
}

function processData(input) {
  validateInput(input);
  const result = computeResult(input.length || 0);
  return formatResponse({ processed: true, result });
}

function computeResult(x) {
  return x * 2;
}

/**
 * Busy-wait for the given duration (used by /slow to trigger a timeout
 * incident). Exposed here so the AST instrumentation (which only transforms
 * require()'d modules) can wrap it — Express app.js is the entry module and
 * never gets instrumented, so its inline while-loop wouldn't be captured.
 */
function busyWait(durationMs) {
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    // spin
  }
  return Date.now() - start;
}

/**
 * Custom error class to mirror Python's ValueError.
 */
class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

/**
 * Async variant of validateInput — throws ValueError when value is falsy.
 * The real `await` (not just returning a Promise) ensures the function is
 * compiled with [[IsAsync]] true, so the AST registry tags the call_path
 * entry with is_async=true.
 */
async function asyncValidate(value) {
  await new Promise(r => setTimeout(r, 5));
  if (!value) {
    throw new ValueError('async validation failed');
  }
  return true;
}

module.exports = {
  processData,
  validateInput,
  formatResponse,
  computeResult,
  busyWait,
  asyncValidate,
  ValueError,
};
