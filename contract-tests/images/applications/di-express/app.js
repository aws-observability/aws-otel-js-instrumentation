// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Express app for DI contract tests.
 *
 * Starts a mock DI API on port 3030, then runs the Express app on port 8080.
 * The DI poller will fetch PROBE/BREAKPOINT configs from the mock API.
 *
 * Snapshots are emitted as OTLP LogRecords via SnapshotOtlpEmitter to the
 * mock collector (no file-based /snapshots endpoint needed).
 */

const express = require('express');
const { startMockDIApi } = require('./mock_di_api');

// Start mock DI API before Express starts
startMockDIApi(3030);
console.log('Mock DI API started on port 3030');

const app = express();
app.use(express.json());

// =========================================================================
// Instrumented functions — each corresponds to a DI config (BREAKPOINT)
// =========================================================================

/**
 * Function-level BREAKPOINT target.
 * Configured with lineNumber pointing to first executable line.
 */
function processData(value) {
  const result = value * 2;
  return result;
}

/**
 * PROBE target - permanent instrumentation, no hit limit.
 */
function computeTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item;
  }
  return total; // Returns 60 for [10, 20, 30]
}

/**
 * Line-level BREAKPOINT target.
 * Configured with specific lineNumber > 0.
 */
function calculateSum(a, b) {
  const result = a + b; // Line 52 - line-level breakpoint here
  return result;
}

/**
 * BREAKPOINT with MaxHits=3 (only generates limited snapshots).
 */
function limitedFunction(x) {
  return x * 10;
}

/**
 * Function with both PROBE and BREAKPOINT configs.
 */
function sharedFunction(data) {
  const processed = typeof data === 'string' ? data.toUpperCase() : String(data);
  return processed;
}

/**
 * BREAKPOINT target for string truncation limit validation.
 * Config requests MaxStringLength=9999 which gets clamped to 255.
 */
function processLongString(longString) {
  return longString.length;
}

/**
 * BREAKPOINT target for collection width limit validation.
 * Config requests MaxCollectionWidth=9999 which gets clamped to 20.
 */
function processLargeCollection(largeList) {
  return largeList.length;
}

/**
 * BREAKPOINT target for collection depth limit validation.
 * Config requests MaxCollectionDepth=1: the root array is captured, nested arrays are cut.
 */
function processNestedCollection(nested) {
  return nested.length;
}

// =========================================================================
// Routes
// =========================================================================

app.get('/health', (req, res) => {
  res.send('Ready');
});

app.get('/success', (req, res) => {
  const result = processData(42);
  res.json({ status: 'ok', result });
});

app.get('/probe', (req, res) => {
  const total = computeTotal([10, 20, 30]);
  res.json({ status: 'ok', total });
});

app.get('/line-level', (req, res) => {
  const result = calculateSum(5, 7);
  res.json({ status: 'ok', sum: result });
});

app.get('/limited', (req, res) => {
  const result = limitedFunction(3);
  res.json({ status: 'ok', result });
});

app.get('/shared', (req, res) => {
  const result = sharedFunction('hello');
  res.json({ status: 'ok', result });
});

app.get('/limits-string', (req, res) => {
  // 500-char string — exceeds MAX_MAX_STRING_LENGTH (255)
  const longString = 'A'.repeat(500);
  const result = processLongString(longString);
  res.json({ status: 'ok', length: result });
});

app.get('/limits-collection', (req, res) => {
  // 50-element array — exceeds MAX_MAX_COLLECTION_WIDTH (20)
  const largeList = Array.from({ length: 50 }, (_, i) => i + 1);
  const result = processLargeCollection(largeList);
  res.json({ status: 'ok', size: result });
});

app.get('/limits-collection-depth', (req, res) => {
  // 4-level nested array — config MaxCollectionDepth=1 cuts capture below the root array
  const nested = [[[['deep']]]];
  const result = processNestedCollection(nested);
  res.json({ status: 'ok', size: result });
});

app.listen(8080, () => {
  console.log('Ready');
});
