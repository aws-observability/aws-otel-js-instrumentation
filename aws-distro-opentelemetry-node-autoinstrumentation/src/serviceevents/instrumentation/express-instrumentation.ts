// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Express instrumentation for ServiceEvents EndpointMetric and IncidentSnapshot events.
 *
 * Installs hooks into Express applications to:
 * - Track endpoint metrics (requests, duration, status codes)
 * - Trigger incident snapshots on errors or slow requests
 * - Propagate endpoint context to function monitors
 */

import { diag } from '@opentelemetry/api';
import { setCurrentOperation, clearCurrentOperation, ServiceEventsMonitorState } from '../serviceevents-monitor';
import { EndpointMetricCollector } from '../collectors/endpoint-collector';
import { IncidentSnapshotCollector, RequestData } from '../collectors/incident-snapshot-collector';
import { ServiceEventsConfig, shouldTrackEndpoint } from '../config';

// Global references to collectors
let _endpointCollector: EndpointMetricCollector | null = null;
let _incidentSnapshotCollector: IncidentSnapshotCollector | null = null;
let _config: ServiceEventsConfig | null = null;

/**
 * Get the route pattern from an Express request.
 *
 * Tries req.route.path (parameterized), then req.baseUrl + req.route.path,
 * then falls back to req.path.
 */
function getRoutePattern(req: any): string {
  if (req.route?.path) {
    const base = req.baseUrl || '';
    return base + req.route.path;
  }
  return req.path || req.url || '/unknown';
}

/**
 * Extract error info from investigation data for error breakdown.
 */
function extractErrorFromCallPath(exception: Error | null): { errorType: string; functionName: string } | undefined {
  const monitorState = ServiceEventsMonitorState.getInstance();
  const invData = monitorState.peekInvestigationData();

  const errorType = exception?.constructor?.name ?? 'UnknownError';
  let functionName = 'unknown';

  if (invData?.callPath && invData.callPath.length > 0) {
    functionName = invData.callPath[0].functionName ?? 'unknown';
  }

  return { errorType, functionName };
}

/**
 * Resolve a module from the user's application context rather than the ADOT package.
 *
 * When this code runs from within @aws/aws-distro-opentelemetry-node-autoinstrumentation,
 * a plain require('express') resolves from the ADOT package's node_modules — not the
 * user's app. We use createRequire anchored to the main module (the user's entry point)
 * so that express/fastify/koa are found in the user's dependency tree.
 */
function requireFromApp(moduleName: string): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createRequire } = require('module');
  const appRequire = createRequire(require.main?.filename || process.cwd() + '/');
  return appRequire(moduleName);
}

/**
 * Install Express instrumentation hooks.
 *
 * Patches express.application.listen so that every new Express app created
 * after this call gets ServiceEvents middleware injected when listen() is called.
 *
 * Why express.application? Express 4 apps are plain function objects with
 * methods mixed in as OWN properties (via merge-descriptors) from the
 * express.application source object. Object.getPrototypeOf(app) returns
 * Function.prototype — not Express's method source — so patching the
 * prototype chain doesn't work. Patching express.application.listen ensures
 * the patched version gets copied to every new app created by express().
 *
 * @returns true if Express was found and hooks were installed, false otherwise.
 */
export function installExpressHooks(
  endpointCollector?: EndpointMetricCollector,
  incidentSnapshotCollector?: IncidentSnapshotCollector,
  _serviceName?: string,
  config?: ServiceEventsConfig | null
): boolean {
  _endpointCollector = endpointCollector ?? null;
  _incidentSnapshotCollector = incidentSnapshotCollector ?? null;
  _config = config ?? null;

  let express: any;
  try {
    express = requireFromApp('express');
  } catch {
    diag.debug('Express not installed, skipping Express instrumentation');
    return false;
  }

  // express.application is the source object from which Express copies
  // methods (listen, use, get, etc.) onto every new app via merge-descriptors.
  const appProto = express.application;
  if (!appProto || !appProto.listen) {
    diag.debug('Express application prototype not found, skipping');
    return false;
  }

  if (appProto.__serviceeventsPatched) {
    return true;
  }

  // Install global HTTP patches that work for ALL frameworks (Express, Fastify,
  // Koa, Next.js). These must run at init time, not at listen() time, so that
  // non-Express frameworks also get endpoint metrics. Safe to call twice —
  // ServiceEventsInstrumentation also invokes it unconditionally, for cases where
  // Express isn't installed.
  installGlobalHttpPatches();

  try {
    const origListen = appProto.listen;
    appProto.listen = function patchedListen(this: any, ...args: any[]) {
      // Install Express-specific middleware when app starts listening.
      // Wrap in try/catch so a middleware-install failure (e.g. an unexpected
      // Express version whose router internals differ) can NEVER prevent the
      // customer's server from starting — telemetry must fail open. The throw
      // would otherwise propagate synchronously out of app.listen().
      try {
        installMiddleware(this);
      } catch (err) {
        diag.error(`ServiceEvents: failed to install Express middleware, continuing without it: ${err}`);
      }
      return origListen.apply(this, args);
    };
    appProto.__serviceeventsPatched = true;
  } catch (err) {
    diag.error(`Failed to install Express instrumentation: ${err}`);
    return false;
  }

  return true;
}

/**
 * Shared finish processing — called from patched res.end() for ALL frameworks.
 */
/**
 * Per-request investigation teardown: get-and-clear the ALS investigation data
 * (which also decrements the process-global _investigationActiveCount) and clear
 * the current operation. Guarded so it runs at most once per request no matter how
 * many paths reach it (framework finish, the global res.end patch, or a
 * connection-close/abort handler that never reached res.end()). Without the
 * once-guard + abort handler, aborted/hung connections would never decrement and
 * the active count would leak upward, permanently forcing the expensive
 * investigation branch in the monitor hot path.
 *
 * Exported so the Fastify/Koa/Next.js finish hooks can own teardown themselves.
 * Those hooks read the investigation call-path (peekInvestigationData) when they
 * build incident snapshots, and for Fastify/Next.js they fire AFTER res.end() (this
 * module's global patch). If the global patch tore the investigation down, the
 * framework hook would peek an already-cleared ALS and emit empty call_paths — so
 * teardown must wait until the recorder is done. See _processFinish's claimed branch.
 */
export function endInvestigationOnce(req: any): void {
  if (!req || req.__serviceeventsInvestigationEnded) {
    return;
  }
  req.__serviceeventsInvestigationEnded = true;
  try {
    ServiceEventsMonitorState.getInstance().getInvestigationData();
  } catch (err) {
    // Best-effort — never block the response. Trace it so an ALS/state corruption
    // root cause isn't silently masked.
    diag.debug('ServiceEvents: investigation teardown failed', err);
  }
  clearCurrentOperation();
}

function _processFinish(req: any, res: any, startTime: number) {
  // A framework-specific hook (Fastify/Koa/Next.js) records endpoint metrics and
  // incident snapshots from its own response hook and sets __serviceeventsRequestEnded.
  // This global res.end patch fires for those frameworks too, so without this guard
  // every request would be counted twice (inflated request/fault counts, latency
  // histograms, and duplicate incident snapshots). Whichever path runs first records
  // the request; the other observes the flag and skips. Express has no such hook, so
  // for Express this patch is the sole recorder.
  //
  // Do NOT tear the investigation down here. For Fastify and Next.js the framework
  // finish hook fires AFTER res.end() (i.e. after this patch), and it reads the ALS
  // investigation call-path (peekInvestigationData) to build incident snapshots.
  // Clearing it here would strip that call-path, yielding empty call_paths in
  // Fastify/Next.js incident snapshots. The framework hook owns teardown once it has
  // recorded (via endInvestigationOnce); the res.on('close') backstop still guarantees
  // the active-count decrement if no finish hook ever runs (client abort, reply hijack).
  if (req.__serviceeventsRequestEnded) {
    return;
  }
  try {
    const durationMs = performance.now() - startTime;
    const durationNs = durationMs * 1_000_000;
    const statusCode = res.statusCode;
    const route = getRoutePattern(req);

    if (_config && !shouldTrackEndpoint(_config, route, req.method)) return;

    let errorInfo: { errorType: string; functionName: string } | undefined;
    if (statusCode >= 400) {
      errorInfo = extractErrorFromCallPath(req.__serviceeventsException ?? null);
    }

    if (_endpointCollector) {
      _endpointCollector.recordRequest(route, req.method, statusCode, durationNs, errorInfo);
    }

    const incidentThreshold = _config?.incidentSnapshotDurationThresholdMs ?? 5000;
    if (_incidentSnapshotCollector && (statusCode >= 400 || durationMs > incidentThreshold)) {
      const requestData: RequestData = {
        headers: req.headers ?? {},
      };
      const exemplar = _incidentSnapshotCollector.processPotentialIncident(
        route,
        req.method,
        statusCode,
        durationMs,
        req.__serviceeventsException ?? null,
        requestData
      );
      if (exemplar && _endpointCollector) {
        _endpointCollector.recordIncidentExemplar(`${req.method} ${route}`, exemplar);
      }
    }
  } finally {
    // End investigation and clear operation context (idempotent per request).
    endInvestigationOnce(req);
  }
}

/**
 * Install global HTTP patches for endpoint metrics. These work for ALL
 * frameworks since they patch Node's http.ServerResponse and http.Server.
 *
 * Exported so ServiceEventsInstrumentation.initialize() can call this unconditionally
 * so endpoint metrics work even when Express is not installed. Idempotent via
 * `__serviceeventsPatched` / `__serviceeventsRequestHooked` guards.
 */
export function installGlobalHttpPatches(): void {
  const http = require('http');

  // Patch ServerResponse.prototype.end ONCE to capture metrics on response
  // completion. This avoids per-request res.on('finish') listener overhead.
  if (!http.ServerResponse.prototype.__serviceeventsPatched) {
    const _origEnd = http.ServerResponse.prototype.end;
    http.ServerResponse.prototype.__serviceeventsPatched = true;
    http.ServerResponse.prototype.end = function (this: any, ...args: any[]) {
      const req = this.req;
      const startTime = req?.__serviceeventsStartTime;
      if (startTime) {
        _processFinish(req, this, startTime);
      }
      return _origEnd.apply(this, args);
    };
  }

  // Universal request tagging: set __serviceeventsStartTime on every incoming
  // request so metrics work for ALL frameworks (Express, Fastify, Koa, Next.js).
  if (!http.Server.prototype.__serviceeventsRequestHooked) {
    http.Server.prototype.__serviceeventsRequestHooked = true;
    const _origServerEmit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (this: any, event: string, ...args: any[]) {
      if (event === 'request') {
        const req = args[0];
        const res = args[1];
        if (req && !req.__serviceeventsStartTime) {
          req.__serviceeventsStartTime = performance.now();
          // Stamp the ALS with the raw URL path on arrival; framework middleware
          // overwrites with the resolved operation ("METHOD /route") once routing
          // has matched. The ALS is AST-only scaffolding.
          const url = req.url || '/';
          const qIdx = url.indexOf('?');
          setCurrentOperation(qIdx >= 0 ? url.substring(0, qIdx) : url);
          // Begin investigation tracking so exceptions and call paths are recorded
          ServiceEventsMonitorState.getInstance().beginInvestigation();
          // Guarantee the matching investigation teardown (active-count decrement)
          // even when the response never reaches res.end() — e.g. client abort or
          // socket hangup. Without this, _investigationActiveCount leaks upward and
          // permanently forces the expensive investigation branch on every call.
          // endInvestigationOnce is idempotent, so the normal finish path is safe.
          if (res && typeof res.on === 'function') {
            res.on('close', () => endInvestigationOnce(req));
          }
        }
      }
      return _origServerEmit.apply(this, [event, ...args]);
    };
  }
}

/**
 * Install ServiceEvents middleware into an Express app.
 *
 * This is called from the patched listen(), at which point all routes are
 * already registered. A plain app.use() would append middleware AFTER all
 * routes — meaning requests handled by routes would never reach our
 * middleware. To fix this, we insert our middleware layer at the FRONT
 * of Express's internal router stack so it runs before any route handler.
 */
function installMiddleware(app: any): void {
  if (app.__serviceeventsMiddlewareInstalled) {
    return;
  }

  // Get the router (Express 4 uses app._router, Express 5 uses app.router)
  const getRouter = () => app._router || app.router;

  // Force the router to be initialized if it hasn't been already.
  if (!getRouter()) {
    if (typeof app.lazyrouter === 'function') {
      app.lazyrouter(); // Express 4 internal method
    }
  }

  // Before middleware: absolute minimum per-request work.
  // Only: performance.now() + 1 property write + ALS set + indexOf (no split).
  const beforeMiddleware = (req: any, res: any, next: any) => {
    req.__serviceeventsStartTime = performance.now();

    // Set operation context using literal URL (indexOf is faster than split).
    // Post-routing middleware upgrades this to "METHOD /route" when available.
    const url = req.url || '/';
    const qIdx = url.indexOf('?');
    setCurrentOperation(qIdx >= 0 ? url.substring(0, qIdx) : url);

    next();
  };

  // Error-handling middleware: capture exceptions.
  // This must run BEFORE any user error handlers so that we capture
  // req.__serviceeventsException even if the user's handler sends a response
  // without calling next(err).
  const errorMiddleware = (err: any, req: any, res: any, next: any) => {
    // Store exception for later processing by res.on('finish') handler
    req.__serviceeventsException = err;
    next(err);
  };

  // Use app.use() to create properly configured Layer objects (with the
  // correct path-matching options like { end: false } that Express sets
  // internally). Then rearrange the stack so our before-middleware runs
  // first and our error-middleware runs before user error handlers.

  // 1. Add before-middleware via app.use() — appends to end of stack
  app.use(beforeMiddleware);
  // Remove the just-added layer from the end and insert at the front
  // so it runs before any route handler.
  const router = getRouter();
  if (router && router.stack) {
    const serviceeventsBeforeLayer = router.stack.pop();
    router.stack.unshift(serviceeventsBeforeLayer);
  }

  // 2. Add error-middleware via app.use(), then move it before any existing
  //    error handlers. Express identifies error handlers by function arity
  //    (handle.length === 4). We insert ours before the first one so we
  //    capture the exception before a user handler consumes it.
  app.use(errorMiddleware);
  if (router && router.stack) {
    const serviceeventsErrorLayer = router.stack.pop();
    let errorInsertIndex: number = router.stack.length;
    for (let i = 0; i < router.stack.length; i++) {
      const layer = router.stack[i];
      if (layer.handle && layer.handle.length === 4) {
        errorInsertIndex = i;
        break;
      }
    }
    router.stack.splice(errorInsertIndex, 0, serviceeventsErrorLayer);
  }

  app.__serviceeventsMiddlewareInstalled = true;
  diag.info('ServiceEvents Express middleware installed on app');
}
