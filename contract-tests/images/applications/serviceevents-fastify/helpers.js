// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Helpers mirror serviceevents-express/helpers.js so the same contract test
// suite works against both frameworks.

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

function busyWait(durationMs) {
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    // spin
  }
  return Date.now() - start;
}

async function asyncValidate(value) {
  await new Promise(r => setTimeout(r, 5));
  if (!value) {
    throw new ValueError('async validation failed');
  }
  return true;
}

class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
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
