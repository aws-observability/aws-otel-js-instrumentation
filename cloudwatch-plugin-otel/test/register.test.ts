// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import Module = require('module');

// register.ts is loaded via --require, frequently process-wide through NODE_OPTIONS, so a load-time
// exception would abort every Node process on the host — including ones with no OpenTelemetry
// installed at all (@opentelemetry/sdk-node is a devDependency of this package, so consumers do not
// get it transitively). The module must degrade to a warning, never a crash.
describe('register (load-time fail-safe)', () => {
  const REGISTER_PATH = require.resolve('../src/register');

  function requireRegisterWithSdkNodeHidden(): { threw: unknown; stderr: string } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const moduleAny = Module as any;
    const originalResolve = moduleAny._resolveFilename;
    // Hide sdk-node (and auto-instrumentations-node, so the primary resolution path also fails) the
    // way an app without OpenTelemetry would: resolution throws MODULE_NOT_FOUND.
    moduleAny._resolveFilename = function (request: string, ...args: unknown[]) {
      if (
        request.startsWith('@opentelemetry/sdk-node') ||
        request.startsWith('@opentelemetry/auto-instrumentations-node')
      ) {
        const err: NodeJS.ErrnoException = new Error(`Cannot find module '${request}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return originalResolve.call(this, request, ...args);
    };

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    // Capture WITHOUT forwarding: the fail-safe banner from this passing test would otherwise be
    // printed into every suite run and read like a real failure.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    delete require.cache[REGISTER_PATH];
    let threw: unknown;
    try {
      require(REGISTER_PATH);
    } catch (e) {
      threw = e;
    } finally {
      process.stderr.write = originalWrite;
      moduleAny._resolveFilename = originalResolve;
      delete require.cache[REGISTER_PATH];
    }
    return { threw, stderr: stderrChunks.join('') };
  }

  it('does not throw when @opentelemetry/sdk-node cannot be resolved, and surfaces a stderr notice', () => {
    const { threw, stderr } = requireRegisterWithSdkNodeHidden();
    assert.strictEqual(threw, undefined, `register must never crash the host at load; threw: ${threw}`);
    assert.ok(
      stderr.includes('span metrics are DISABLED'),
      `expected a visible stderr notice (diag is not yet wired at --require time); got: ${JSON.stringify(stderr)}`
    );
  });
});
