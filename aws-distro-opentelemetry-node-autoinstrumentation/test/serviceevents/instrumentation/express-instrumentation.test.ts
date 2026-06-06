// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from 'http';
import expect from 'expect';
import { installGlobalHttpPatches } from '../../../src/serviceevents/instrumentation/express-instrumentation';
import { getCurrentOperation, resetMonitorState } from '../../../src/serviceevents/serviceevents-monitor';

/**
 * Strategy: don't rely on http.Server.prototype.emit for this test, because
 * other test files may install @opentelemetry/instrumentation-http on top of
 * it, and chaining into that produces unrelated errors (it expects a real
 * socket). Instead, call the patched Server#emit and ServerResponse#end
 * functions through a minimal fake `this` — that verifies OUR patch logic
 * in isolation without invoking unrelated downstream wrappers.
 *
 * We install the patches once, grab the patched function references, and
 * restore the pristine prototypes in `after()` so other tests see clean HTTP.
 */
describe('installGlobalHttpPatches', function () {
  const pristineEnd = http.ServerResponse.prototype.end;
  const pristineEmit = http.Server.prototype.emit;

  // Before installing our patches, replace http.Server.prototype.emit and
  // http.ServerResponse.prototype.end with minimal no-ops so our patch's
  // captured `_origServerEmit`/`_origEnd` references harmless originals —
  // not `@opentelemetry/instrumentation-http`'s socket-dependent wrappers,
  // which other tests in this suite may have already installed.
  let patchedServerEmit: any;

  before(function () {
    // Install a clean stub so our patch captures it as its "original".
    (http.Server.prototype as any).emit = function () {
      return true;
    };
    (http.ServerResponse.prototype as any).end = function () {
      return this;
    };
    // Reset the idempotency guards so install runs fresh against the stubs.
    delete (http.Server.prototype as any).__serviceeventsRequestHooked;
    delete (http.ServerResponse.prototype as any).__serviceeventsPatched;

    installGlobalHttpPatches();
    patchedServerEmit = http.Server.prototype.emit;
  });

  after(function () {
    // Fully restore the global prototypes so other test files see pristine HTTP.
    http.ServerResponse.prototype.end = pristineEnd;
    http.Server.prototype.emit = pristineEmit;
    delete (http.ServerResponse.prototype as any).__serviceeventsPatched;
    delete (http.Server.prototype as any).__serviceeventsRequestHooked;
  });

  beforeEach(function () {
    resetMonitorState();
  });

  afterEach(function () {
    resetMonitorState();
  });

  // Fake `this` for emit — provides a no-op original emit so chain stops at our patch.
  function fakeServer(): any {
    return {};
  }

  // Invoke the patched Server#emit with a fake `this`. Because Server.prototype
  // is Function.prototype (Node's Server extends EventEmitter), calling the
  // patched function stops at _origServerEmit.apply(this, ...), which in our
  // fake is EventEmitter's — no listeners, returns false, harmless.
  function invokeEmit(req: any): void {
    patchedServerEmit.call(fakeServer(), 'request', req);
  }

  it('is idempotent — calling twice does not double-patch', function () {
    expect((http.Server.prototype as any).__serviceeventsRequestHooked).toBe(true);
    installGlobalHttpPatches();
    expect((http.Server.prototype as any).__serviceeventsRequestHooked).toBe(true);
  });

  describe('request-arrival hook', function () {
    it("stamps startTime and operation ALS on incoming 'request' events", function () {
      const req: any = { url: '/users/42?foo=bar', method: 'GET', headers: {} };
      invokeEmit(req);

      expect(typeof req.__serviceeventsStartTime).toBe('number');
      // Raw URL path (query stripped) is stamped into the operation ALS.
      expect(getCurrentOperation()).toBe('/users/42');
    });

    it('does not re-stamp a request that already has __serviceeventsStartTime', function () {
      const req: any = { url: '/x', method: 'GET', headers: {}, __serviceeventsStartTime: 999 };
      invokeEmit(req);
      expect(req.__serviceeventsStartTime).toBe(999);
    });

    it('handles requests with no query string', function () {
      const req: any = { url: '/health', method: 'GET', headers: {} };
      invokeEmit(req);
      expect(getCurrentOperation()).toBe('/health');
    });
  });
});
