// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from 'http';
import { EventEmitter } from 'events';
import expect from 'expect';
import {
  installGlobalHttpPatches,
  endInvestigationOnce,
} from '../../../src/serviceevents/instrumentation/express-instrumentation';
import {
  getCurrentOperation,
  resetMonitorState,
  ServiceEventsMonitorState,
} from '../../../src/serviceevents/serviceevents-monitor';

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
  let patchedResponseEnd: any;
  // Marker set by the stubbed original end() so tests can assert it actually ran
  // (i.e. that the patch did not throw before delegating to the real end()).
  let origEndRan = false;

  before(function () {
    // Install a clean stub so our patch captures it as its "original".
    (http.Server.prototype as any).emit = function () {
      return true;
    };
    (http.ServerResponse.prototype as any).end = function (this: any) {
      origEndRan = true;
      return this;
    };
    // Reset the idempotency guards so install runs fresh against the stubs.
    delete (http.Server.prototype as any).__serviceeventsRequestHooked;
    delete (http.ServerResponse.prototype as any).__serviceeventsPatched;

    installGlobalHttpPatches();
    patchedServerEmit = http.Server.prototype.emit;
    patchedResponseEnd = http.ServerResponse.prototype.end;
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
  function invokeEmit(req: any, res?: any): void {
    patchedServerEmit.call(fakeServer(), 'request', req, res);
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

  describe('investigation teardown on connection close (abort safety)', function () {
    it('ends the investigation when the response closes without res.end()', function () {
      const state = ServiceEventsMonitorState.getInstance();
      const req: any = { url: '/slow', method: 'GET', headers: {} };
      const res: any = new EventEmitter();

      // Request arrival begins an investigation (ALS populated).
      invokeEmit(req, res);
      expect(state.peekInvestigationData()).not.toBe(null);

      // Client aborts / socket hangs up: res emits 'close' without res.end() ever
      // running. The close handler must run the investigation teardown so the
      // active-count decrement is not skipped (otherwise it would leak upward).
      res.emit('close');
      expect(state.peekInvestigationData()).toBe(null);
    });

    it('does not throw when the request arrives without a response object', function () {
      const req: any = { url: '/x', method: 'GET', headers: {} };
      expect(() => invokeEmit(req)).not.toThrow();
    });
  });

  describe('res.end patch fails open (telemetry never hangs the response)', function () {
    it('still calls the original end() when _processFinish throws', function () {
      // Drive the patched ServerResponse#end with a `res` whose statusCode getter
      // throws — that makes _processFinish throw partway through recording. The
      // patch must swallow it and still delegate to the original end(), so the
      // customer's response completes instead of hanging.
      const req: any = { url: '/boom', method: 'GET', headers: {}, __serviceeventsStartTime: 1 };
      const res: any = { req };
      Object.defineProperty(res, 'statusCode', {
        get() {
          throw new Error('exploding statusCode');
        },
      });

      origEndRan = false;
      expect(() => patchedResponseEnd.call(res)).not.toThrow();
      expect(origEndRan).toBe(true);
    });
  });

  describe('claimed request: global res.end patch must not tear down the investigation early', function () {
    // Regression for the Fastify/Koa/Next.js empty-call_path bug. Those frameworks set
    // req.__serviceeventsRequestEnded in their request-arrival hook to claim
    // endpoint/incident recording (so the global res.end patch does not double-count).
    // For Fastify/Next.js the framework finish hook — which reads the ALS investigation
    // call-path to build the incident snapshot — fires AFTER res.end(). If the global
    // patch tore the investigation down on the claimed path, that later peek would see an
    // empty call-path. The claimed branch must therefore leave teardown to the framework
    // hook (or the res.on('close') backstop).
    it('preserves the investigation call-path when res.end() fires on a claimed request', function () {
      const state = ServiceEventsMonitorState.getInstance();
      const req: any = { url: '/api/orders', method: 'POST', headers: {}, route: { path: '/api/orders' } };
      const res: any = new EventEmitter();
      (res as any).statusCode = 500;
      (res as any).req = req;

      // Request arrival begins an investigation; an instrumented frame records a call-path.
      invokeEmit(req, res);
      state.recordCallPathEntry('orders.create', null, 1234);
      expect(state.peekInvestigationData()?.callPath.length).toBe(1);

      // Framework claims the request (as Fastify/Koa/Next.js do at request arrival).
      req.__serviceeventsRequestEnded = true;

      // The later framework finish hook can still peek a populated call-path.
      const inv = state.peekInvestigationData();
      expect(inv).not.toBe(null);
      expect(inv?.callPath.length).toBe(1);
      expect(inv?.callPath[0].functionName).toBe('orders.create');
    });

    it('endInvestigationOnce tears down exactly once across res.end + framework hook + close', function () {
      const state = ServiceEventsMonitorState.getInstance();
      const req: any = { url: '/api/orders', method: 'POST', headers: {} };
      const res: any = new EventEmitter();
      (res as any).statusCode = 200;
      (res as any).req = req;

      invokeEmit(req, res);
      req.__serviceeventsRequestEnded = true;
      expect(state.peekInvestigationData()).not.toBe(null);

      // The framework finish hook owns teardown after it has recorded.
      endInvestigationOnce(req);
      expect(state.peekInvestigationData()).toBe(null);

      // Idempotent: a redundant close after teardown is a harmless no-op (the
      // once-guard prevents a second get-and-clear / double active-count decrement).
      expect(() => res.emit('close')).not.toThrow();
      expect(state.peekInvestigationData()).toBe(null);
    });
  });
});
