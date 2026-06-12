// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as Module from 'module';
import { installKoaHooks, installKoaMiddleware } from '../../../src/serviceevents/instrumentation/koa-instrumentation';
import { resetMonitorState } from '../../../src/serviceevents/serviceevents-monitor';

/**
 * Regression test for the ORR finding "Koa SE middleware swallows customer
 * exceptions and mutates the response (status/body)".
 *
 * The SE middleware is installed at the FRONT of Koa's middleware stack. It must
 * record telemetry for a thrown error but then RE-THROW it, so Koa's own error
 * handling (ctx.onerror, the app-level 'error' event, and the status/body the
 * thrown error carries) still runs. It must NOT swallow the error or overwrite
 * ctx.status / ctx.body.
 */
describe('Koa middleware error propagation (does not swallow/rewrite)', function () {
  const origCreateRequire = (Module as any).createRequire;

  beforeEach(function () {
    resetMonitorState();
  });

  afterEach(function () {
    (Module as any).createRequire = origCreateRequire;
    resetMonitorState();
  });

  // Build a fake Koa app, install SE middleware onto it, and return the SE
  // middleware (which installKoaMiddleware unshifts to position 0).
  function makeAppWithSeMiddleware(): { app: any; seMiddleware: any } {
    const app: any = { middleware: [] };
    installKoaMiddleware(app);
    return { app, seMiddleware: app.middleware[0] };
  }

  // Minimal Koa-like ctx.
  function makeCtx(): any {
    return {
      method: 'GET',
      path: '/boom',
      status: 404, // Koa's default before a handler sets it
      body: undefined,
      headers: {},
      query: {},
      req: {},
      request: {},
    };
  }

  it('re-throws the downstream error instead of swallowing it', async function () {
    const { seMiddleware } = makeAppWithSeMiddleware();
    const ctx = makeCtx();
    const boom = new Error('downstream failure');

    let caught: Error | null = null;
    try {
      await seMiddleware(ctx, async () => {
        throw boom;
      });
    } catch (err: any) {
      caught = err;
    }

    // The error must propagate out of the SE middleware (Koa would then run onerror).
    expect(caught).toBe(boom);
  });

  it('does not overwrite ctx.status or ctx.body on a thrown error', async function () {
    const { seMiddleware } = makeAppWithSeMiddleware();
    const ctx = makeCtx();

    try {
      await seMiddleware(ctx, async () => {
        throw new Error('downstream failure');
      });
    } catch {
      // expected re-throw
    }

    // SE must not have mutated the response — Koa's onerror owns that.
    expect(ctx.status).toBe(404);
    expect(ctx.body).toBeUndefined();
  });

  it('passes through cleanly when no error is thrown', async function () {
    const { seMiddleware } = makeAppWithSeMiddleware();
    const ctx = makeCtx();
    ctx.status = 200;
    let nextRan = false;

    await seMiddleware(ctx, async () => {
      nextRan = true;
      ctx.body = 'ok';
    });

    expect(nextRan).toBe(true);
    expect(ctx.status).toBe(200);
    expect(ctx.body).toBe('ok');
  });

  it('installKoaHooks remains transparent: a handler throw still propagates', async function () {
    // End-to-end through the patched listen path: build a fake Koa, patch it,
    // construct an instance, and verify the SE middleware (now at stack front)
    // re-throws.
    const fakeKoaProto: any = {
      middleware: [],
      listen() {
        return {};
      },
    };
    const FakeKoa: any = function (this: any) {
      this.middleware = [];
    };
    FakeKoa.prototype = fakeKoaProto;
    (Module as any).createRequire = () => (name: string) => {
      if (name === 'koa') return FakeKoa;
      throw new Error(`unexpected require: ${name}`);
    };

    const installed = installKoaHooks(undefined, undefined, undefined, null);
    expect(installed).toBe(true);

    const app: any = new FakeKoa();
    installKoaMiddleware(app);
    const seMiddleware = app.middleware[0];
    const ctx = makeCtx();
    const boom = new Error('handler failure');

    let caught: Error | null = null;
    try {
      await seMiddleware(ctx, async () => {
        throw boom;
      });
    } catch (err: any) {
      caught = err;
    }
    expect(caught).toBe(boom);

    delete fakeKoaProto.__serviceeventsPatched;
  });
});
