// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as path from 'path';
import * as fs from 'fs';
import { diag } from '@opentelemetry/api';
import { InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { AwsLambdaInstrumentationPatch } from '../../../src/patches/extended-instrumentations/aws-lambda';

describe('AwsLambdaInstrumentationPatch', () => {
  let instrumentation: AwsLambdaInstrumentationPatch;

  beforeEach(() => {
    instrumentation = new AwsLambdaInstrumentationPatch({});
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('init', () => {
    it('should skip instrumentation when LAMBDA_TASK_ROOT and _HANDLER are not set', () => {
      process.env.LAMBDA_TASK_ROOT = '';
      process.env._HANDLER = '';

      const result = instrumentation.init();

      assert.strictEqual(result.length, 0);
    });

    it('should fallback to .cjs if .js does not exist', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task';
      process.env._HANDLER = 'src/index.handler';

      sinon.stub(path, 'basename').returns('index.handler');
      sinon
        .stub(fs, 'statSync')
        .onFirstCall()
        .throws(new Error('File not found')) // .js file does not exist
        .onSecondCall()
        .returns({} as any); // .cjs file exists

      const result = instrumentation.init();

      assert.strictEqual(result[0].name, '/var/task/src/index.cjs');
    });

    it('should fallback to .mjs when .js and .cjs do not exist', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task';
      process.env._HANDLER = 'src/index.handler';

      sinon.stub(path, 'basename').returns('index.handler');
      sinon
        .stub(fs, 'statSync')
        .onFirstCall()
        .throws(new Error('File not found')) // .js not found
        .onSecondCall()
        .throws(new Error('File not found')); // .cjs not found

      const result = instrumentation.init();

      assert.strictEqual(result[0].name, '/var/task/src/index.mjs');
    });

    it('should instrument CommonJS handler correctly', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task';
      process.env._HANDLER = 'src/index.handler';

      sinon.stub(path, 'basename').returns('index.handler');
      sinon.stub(fs, 'statSync').returns({} as any); // Mock that the .js file exists
      const debugStub = sinon.stub(diag, 'debug');

      const result = instrumentation.init();

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, '/var/task/src/index.js');
      assert(result[0] instanceof InstrumentationNodeModuleDefinition);
      assert.strictEqual(result[0].files.length, 1);
      assert(debugStub.calledWithMatch('Instrumenting lambda handler', sinon.match.object));
    });

    it('should return ESM instrumentation for .mjs files or when HANDLER_IS_ESM is set', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task';
      process.env._HANDLER = 'src/index.handler';
      process.env.HANDLER_IS_ESM = 'true'; // ESM environment variable set

      sinon.stub(path, 'basename').returns('index.handler');
      sinon.stub(fs, 'statSync').throws(new Error('File not found')); // No .js or .cjs file exists

      const result = instrumentation.init();

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, '/var/task/src/index.mjs');
      assert(result[0] instanceof InstrumentationNodeModuleDefinition);
      assert.strictEqual(result[0].files.length, 0); //
      delete process.env.HANDLER_IS_ESM;
    });
  });

  it('should apply and remove patches correctly for a MJS handler', () => {
    process.env.LAMBDA_TASK_ROOT = '/var/task';
    process.env._HANDLER = 'src/index.handler';
    process.env.HANDLER_IS_ESM = 'true'; // ESM environment variable set

    // Mock the module exports object with a sample function
    const fakeModuleExports = { handler: sinon.stub() };

    const wrapSpy = sinon.spy(instrumentation, '_wrap' as any);
    const unwrapSpy = sinon.spy(instrumentation, '_unwrap' as any);

    const result = instrumentation.init()[0];
    // Ensure result contains patch and unpatch functions
    assert(result.patch, 'patch function should be defined');
    assert(result.unpatch, 'unpatch function should be defined');

    // Call the patch function with the mocked module exports
    result.patch(fakeModuleExports);

    // Assert that wrap is called after patching
    assert(wrapSpy.calledOnce, '_wrap should be called once when patch is applied');

    // Call the unpatch function with the mocked module exports
    result.unpatch(fakeModuleExports);

    // Assert that unwrap is called after unpatching
    assert(unwrapSpy.calledOnce, '_unwrap should be called once when unpatch is called');

    delete process.env.HANDLER_IS_ESM;
  });

  it('should apply and remove patches correctly for a CJS handler', () => {
    process.env.LAMBDA_TASK_ROOT = '/var/task';
    process.env._HANDLER = 'src/index.handler';

    // Mock the module exports object with a sample function
    const fakeModuleExports = { handler: sinon.stub() };
    sinon.stub(fs, 'statSync').returns({} as any); // Mock that the .js file exists

    const wrapSpy = sinon.spy(instrumentation, '_wrap' as any);
    const unwrapSpy = sinon.spy(instrumentation, '_unwrap' as any);

    const result = instrumentation.init()[0];
    // Ensure result contains patch and unpatch functions
    assert(result.files[0].patch, 'patch function should be defined');
    assert(result.files[0].unpatch, 'unpatch function should be defined');

    // Call the patch function with the mocked module exports
    result.files[0].patch(fakeModuleExports);

    // Assert that wrap is called after patching
    assert(wrapSpy.calledOnce, '_wrap should be called once when patch is applied');

    // Call the unpatch function with the mocked module exports
    result.files[0].unpatch(fakeModuleExports);

    // Assert that unwrap is called after unpatching
    assert(unwrapSpy.calledOnce, '_unwrap should be called once when unpatch is called');
  });
});
