// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from 'http';
import expect from 'expect';
import { installGlobalHttpPatches } from '../../../src/serviceevents/instrumentation/express-instrumentation';
import { getCurrentOperation, resetMonitorState } from '../../../src/serviceevents/serviceevents-monitor';
import { getCompletedRequests, resetRequestTracker } from '../../../src/serviceevents/profiler/request-tracker';
import { getHolder, resetProfilerContext } from '../../../src/serviceevents/profiler/profiler-context';

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
    resetRequestTracker();
    resetProfilerContext();
  });

  afterEach(function () {
    resetMonitorState();
    resetRequestTracker();
    resetProfilerContext();
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
    it("stamps seq, startNs, operation ALS, and profiler holder on incoming 'request' events", function () {
      const req: any = { url: '/users/42?foo=bar', method: 'GET', headers: {} };
      invokeEmit(req);

      expect(typeof req.__serviceeventsSeq).toBe('number');
      expect(req.__serviceeventsSeq).toBeGreaterThan(0);
      expect(typeof req.__serviceeventsStartTime).toBe('number');
      expect(typeof req.__serviceeventsStartNs).toBe('number');
      // Raw URL path (query stripped) is stamped into the operation ALS.
      expect(getCurrentOperation()).toBe('/users/42');
      // Profiler holder carries the same seq for pprof sample labels.
      expect(getHolder().ref).toEqual({ seq: req.__serviceeventsSeq });
    });

    it('does not re-stamp a request that already has __serviceeventsStartTime', function () {
      const req: any = { url: '/x', method: 'GET', headers: {}, __serviceeventsStartTime: 999 };
      invokeEmit(req);
      expect(req.__serviceeventsStartTime).toBe(999);
      expect(req.__serviceeventsSeq).toBeUndefined();
    });

    it('handles requests with no query string', function () {
      const req: any = { url: '/health', method: 'GET', headers: {} };
      invokeEmit(req);
      expect(getCurrentOperation()).toBe('/health');
    });
  });

  describe('response-end hook (_processFinish)', function () {
    // The patched end() calls the original end at the tail, which fails without
    // a real socket. _processFinish's side effect (endRequest) runs *before*
    // that call, so we tolerate the write failure.
    it('pushes {seq, startNs, endNs, operation} into the completed-requests ring', function () {
      const req: any = { url: '/api/users', method: 'POST', headers: {}, route: { path: '/api/users' } };
      invokeEmit(req);
      const seq = req.__serviceeventsSeq;

      const res: any = { statusCode: 200, req };
      patchedResponseEnd.call(res);

      const completed = getCompletedRequests().findBySeq(seq);
      expect(completed).toBeDefined();
      expect(completed!.operation).toBe('POST /api/users');
      expect(completed!.startNs).toBeGreaterThan(0);
      expect(completed!.endNs).toBeGreaterThanOrEqual(completed!.startNs);
    });

    it('falls back to raw URL when req.route is missing', function () {
      const req: any = { url: '/healthz', method: 'GET', headers: {} };
      invokeEmit(req);

      const res: any = { statusCode: 200, req };
      try {
        patchedResponseEnd.call(res);
      } catch {
        // ignored
      }
      const completed = getCompletedRequests().findBySeq(req.__serviceeventsSeq);
      // getRoutePattern falls back to req.path || req.url || '/unknown'.
      expect(completed!.operation).toBe('GET /healthz');
    });
  });
});
