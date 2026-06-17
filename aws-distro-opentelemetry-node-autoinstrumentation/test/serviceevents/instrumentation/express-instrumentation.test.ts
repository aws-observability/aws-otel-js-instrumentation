// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from 'http';
import { EventEmitter } from 'events';
import expect from 'expect';
import {
  installGlobalHttpPatches,
  installExpressHooks,
  endInvestigationOnce,
} from '../../../src/serviceevents/instrumentation/express-instrumentation';
import {
  getCurrentOperation,
  resetMonitorState,
  ServiceEventsMonitorState,
} from '../../../src/serviceevents/serviceevents-monitor';
import { EndpointMetricCollector } from '../../../src/serviceevents/collectors/endpoint-collector';

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

  describe('res.end patch records a request at most once (no double-count)', function () {
    it('records the request once even if res.end() fires twice', function () {
      // Express has no framework hook — this global patch is the sole recorder. res.end()
      // can fire more than once (chained error handlers, stream pipe edge cases, manual
      // double-end). The patch must record the request exactly once.
      let recordCount = 0;
      const spyCollector = new EndpointMetricCollector(600_000, 'env', 'svc', '0.0.1');
      (spyCollector as any).recordRequest = () => {
        recordCount++;
      };
      // installExpressHooks wires the module-level _endpointCollector before it tries to
      // require('express'); it returns false here (no express) but the collector is set.
      installExpressHooks(spyCollector, undefined, 'svc', null);

      // __serviceeventsStartTime must be set or the patched end() skips _processFinish.
      const req: any = {
        url: '/api/users',
        method: 'GET',
        headers: {},
        route: { path: '/api/users' },
        __serviceeventsStartTime: 1,
      };
      const res: any = { statusCode: 200, req };

      try {
        patchedResponseEnd.call(res);
      } catch {
        // patched end() calls the stubbed original at the tail; tolerate.
      }
      try {
        patchedResponseEnd.call(res); // second end() must be a no-op for recording
      } catch {
        // ignore
      }

      expect(recordCount).toBe(1);
      // Reset module collector so other tests aren't affected.
      installExpressHooks(undefined, undefined, undefined, null);
    });
  });

  describe('unmatched routes collapse to the first path segment (cardinality bound)', function () {
    it('records the first path segment for an unmatched EXPRESS request (req.route absent)', function () {
      // A genuine Express request that matched no route (404, static middleware) has no
      // req.route. Recording its raw path (/users/12345, /assets/<hash>.js) would explode
      // endpoint cardinality, so an unmatched request collapses to its first path segment
      // (/users/12345 -> /users), matching Application Signals' unmatched-route handling.
      const recordedRoutes: string[] = [];
      const spyCollector = new EndpointMetricCollector(600_000, 'env', 'svc', '0.0.1');
      (spyCollector as any).recordRequest = (route: string) => {
        recordedRoutes.push(route);
      };
      installExpressHooks(spyCollector, undefined, 'svc', null);

      const req: any = {
        url: '/users/12345',
        method: 'GET',
        headers: {},
        path: '/users/12345',
        originalUrl: '/users/12345', // Express marker
        app: {}, // Express marker
        __serviceeventsStartTime: 1,
      };
      const res: any = { statusCode: 404, req };
      try {
        patchedResponseEnd.call(res);
      } catch {
        // tolerate stubbed original end()
      }

      expect(recordedRoutes).toEqual(['/users']);
      installExpressHooks(undefined, undefined, undefined, null);
    });

    it('collapses scanner traffic with a deep path to its first segment', function () {
      // Scanner/bot traffic to nonexistent deep URLs (/wp-admin/setup-config.php) must not
      // each become a distinct endpoint key — they collapse to the shared first segment.
      const recordedRoutes: string[] = [];
      const spyCollector = new EndpointMetricCollector(600_000, 'env', 'svc', '0.0.1');
      (spyCollector as any).recordRequest = (route: string) => {
        recordedRoutes.push(route);
      };
      installExpressHooks(spyCollector, undefined, 'svc', null);

      // Raw Node IncomingMessage shape — no `app`, no `originalUrl`, no `route`.
      const req: any = {
        url: '/wp-admin/setup-config.php',
        method: 'GET',
        headers: {},
        __serviceeventsStartTime: 1,
      };
      const res: any = { statusCode: 404, req };
      try {
        patchedResponseEnd.call(res);
      } catch {
        // tolerate
      }

      expect(recordedRoutes).toEqual(['/wp-admin']);
      installExpressHooks(undefined, undefined, undefined, null);
    });

    it('still records the parameterized pattern when req.route is present', function () {
      const recordedRoutes: string[] = [];
      const spyCollector = new EndpointMetricCollector(600_000, 'env', 'svc', '0.0.1');
      (spyCollector as any).recordRequest = (route: string) => {
        recordedRoutes.push(route);
      };
      installExpressHooks(spyCollector, undefined, 'svc', null);

      const req: any = {
        url: '/users/12345',
        method: 'GET',
        headers: {},
        route: { path: '/users/:id' },
        __serviceeventsStartTime: 1,
      };
      const res: any = { statusCode: 200, req };
      try {
        patchedResponseEnd.call(res);
      } catch {
        // tolerate
      }

      expect(recordedRoutes).toEqual(['/users/:id']);
      installExpressHooks(undefined, undefined, undefined, null);
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

  describe('error breakdown on a 5xx: extractErrorFromCallPath recovery vs. Java-parity omission', function () {
    // Capture the errorInfo argument the hook passes to recordRequest by spying on a
    // real collector — the same end-to-end path production uses (global res.end patch →
    // _processFinish → extractErrorFromCallPath(req.__serviceeventsException ?? null)).
    function recordWithSpy(req: any, res: any): Array<{ errorType: string; functionName: string } | undefined> {
      const captured: Array<{ errorType: string; functionName: string } | undefined> = [];
      const spyCollector = new EndpointMetricCollector(600_000, 'env', 'svc', '0.0.1');
      (spyCollector as any).recordRequest = (
        _route: string,
        _method: string,
        _statusCode: number,
        _durationNs: number,
        errorInfo?: { errorType: string; functionName: string }
      ) => {
        captured.push(errorInfo);
      };
      installExpressHooks(spyCollector, undefined, 'svc', null);
      try {
        patchedResponseEnd.call(res);
      } catch {
        // tolerate the stubbed original end()
      } finally {
        installExpressHooks(undefined, undefined, undefined, null);
      }
      return captured;
    }

    it('recovers the monitor-captured exception type on a 5xx when the hook received no exception', function () {
      // FastAPI-global-handler equivalent: a framework error handler converted the error to a
      // 500 BEFORE the request reached our hook, so req.__serviceeventsException is unset — but
      // the monitor captured the real exception during the instrumented call. The breakdown must
      // carry the recovered type (and origin function), not a synthetic "UnknownError".
      const state = ServiceEventsMonitorState.getInstance();
      // Do NOT pre-set __serviceeventsStartTime — the arrival hook only begins the
      // investigation for a request it hasn't seen (no existing start time).
      const req: any = {
        url: '/api/orders',
        method: 'POST',
        headers: {},
        route: { path: '/api/orders' },
      };
      const res: any = { statusCode: 500, req };

      // Request arrival begins the investigation; the monitor records the thrown exception.
      invokeEmit(req, res);
      const inv = state.peekInvestigationData();
      expect(inv).not.toBe(null);
      inv!.exception = {
        name: 'KeyError',
        message: 'missing id',
        traceback: '',
        functionName: 'orders.lookup',
      };
      // Note: req.__serviceeventsException is deliberately NOT set.

      const captured = recordWithSpy(req, res);

      expect(captured.length).toBe(1);
      expect(captured[0]).toEqual({ errorType: 'KeyError', functionName: 'orders.lookup' });
    });

    it('omits the breakdown on a 5xx with neither a passed-in nor a captured exception (Java parity)', function () {
      // A handler that returns a 500 status without ever throwing, and with no instrumented frame
      // having captured an exception. There is no real error type, so the extractor returns
      // undefined and the hook passes errorInfo=undefined — matching Java's `errorType != null`
      // gate. No synthetic "UnknownError" breakdown is produced.
      const req: any = {
        url: '/api/orders',
        method: 'POST',
        headers: {},
        route: { path: '/api/orders' },
      };
      const res: any = { statusCode: 500, req };

      invokeEmit(req, res); // begins an investigation, but no exception is ever recorded

      const captured = recordWithSpy(req, res);

      expect(captured.length).toBe(1);
      expect(captured[0]).toBeUndefined();
    });
  });
});
