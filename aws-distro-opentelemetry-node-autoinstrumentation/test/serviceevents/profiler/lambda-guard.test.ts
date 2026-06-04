// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { isRunningInLambda } from '../../../src/serviceevents/profiler/lambda-guard';

describe('isRunningInLambda', function () {
  const original = process.env.AWS_LAMBDA_FUNCTION_NAME;

  afterEach(function () {
    if (original === undefined) {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    } else {
      process.env.AWS_LAMBDA_FUNCTION_NAME = original;
    }
  });

  it('returns false when env var is unset', function () {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    expect(isRunningInLambda()).toBe(false);
  });

  it('returns false when env var is empty', function () {
    process.env.AWS_LAMBDA_FUNCTION_NAME = '';
    expect(isRunningInLambda()).toBe(false);
  });

  it('returns true when env var is set', function () {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';
    expect(isRunningInLambda()).toBe(true);
  });
});
