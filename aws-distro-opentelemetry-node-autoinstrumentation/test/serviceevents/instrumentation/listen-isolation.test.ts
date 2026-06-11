// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as Module from 'module';
import { installExpressHooks } from '../../../src/serviceevents/instrumentation/express-instrumentation';
import { installKoaHooks } from '../../../src/serviceevents/instrumentation/koa-instrumentation';

/**
 * Regression test for the ORR finding "patchedListen → installMiddleware has no
 * try/catch; a throw breaks customer app.listen()".
 *
 * ServiceEvents patches `express.application.listen` / `Koa.prototype.listen` to
 * inject middleware when the customer calls app.listen(). If the middleware-install
 * step throws (e.g. an Express/Koa version whose router internals differ from what
 * we expect), that exception MUST NOT propagate out of the customer's app.listen()
 * call — telemetry must fail open so the customer's server still boots.
 *
 * We force installMiddleware to throw by handing the patch a router/app object whose
 * internals blow up, and assert the original listen() still runs.
 */
describe('app.listen() patch isolation (telemetry fails open)', function () {
  // installExpressHooks / installKoaHooks resolve the framework via createRequire
  // anchored at the app's main module. We stub Module.createRequire so the hooks
  // see our fake express/koa modules instead of the real ones.
  const origCreateRequire = (Module as any).createRequire;

  afterEach(function () {
    (Module as any).createRequire = origCreateRequire;
  });

  it('Express: a throwing installMiddleware does not prevent origListen from running', function () {
    let origListenCalled = false;

    // A fake express.application whose `use()` throws — installMiddleware calls
    // app.use(beforeMiddleware), so this drives the install into its failure path.
    const fakeApp: any = {
      listen: function (this: any) {
        origListenCalled = true;
        return { __fakeServer: true };
      },
      use() {
        throw new Error('simulated incompatible Express internals');
      },
      lazyrouter() {
        /* no-op */
      },
    };

    const fakeExpress: any = { application: fakeApp };
    (Module as any).createRequire = () => (name: string) => {
      if (name === 'express') return fakeExpress;
      throw new Error(`unexpected require: ${name}`);
    };

    const installed = installExpressHooks(undefined, undefined, undefined, null);
    expect(installed).toBe(true);

    // Calling the patched listen() must NOT throw, and must still invoke origListen.
    expect(() => fakeApp.listen()).not.toThrow();
    expect(origListenCalled).toBe(true);

    // cleanup the patch guard so other tests re-patch cleanly
    delete fakeApp.__serviceeventsPatched;
  });

  it('Koa: a throwing installKoaMiddleware does not prevent origListen from running', function () {
    let origListenCalled = false;

    // Koa middleware install reassigns app.middleware = [...]. Make the getter throw.
    const fakeKoaProto: any = {
      listen: function (this: any) {
        origListenCalled = true;
        return { __fakeServer: true };
      },
      get middleware() {
        throw new Error('simulated incompatible Koa internals');
      },
    };
    const FakeKoa: any = function () {
      /* ctor */
    };
    FakeKoa.prototype = fakeKoaProto;

    (Module as any).createRequire = () => (name: string) => {
      if (name === 'koa') return FakeKoa;
      throw new Error(`unexpected require: ${name}`);
    };

    const installed = installKoaHooks(undefined, undefined, undefined, null);
    expect(installed).toBe(true);

    const instance: any = new FakeKoa();
    expect(() => instance.listen()).not.toThrow();
    expect(origListenCalled).toBe(true);

    delete fakeKoaProto.__serviceeventsPatched;
  });
});
