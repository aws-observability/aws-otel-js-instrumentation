// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Koa instrumentation for ServiceEvents EndpointMetric and IncidentSnapshot events.
 *
 * Uses Koa middleware to:
 * - Track endpoint metrics (requests, duration, status codes)
 * - Trigger incident snapshots on errors or slow requests
 * - Propagate endpoint context to function monitors
 */

import { diag } from '@opentelemetry/api';
import { setCurrentOperation, ServiceEventsMonitorState } from '../serviceevents-monitor';
import { EndpointMetricCollector } from '../collectors/endpoint-collector';
import { IncidentSnapshotCollector, RequestData } from '../collectors/incident-snapshot-collector';
import { ServiceEventsConfig, shouldTrackEndpoint } from '../config';
import { endInvestigationOnce } from './express-instrumentation';

// Global references to collectors
let _endpointCollector: EndpointMetricCollector | null = null;
let _incidentSnapshotCollector: IncidentSnapshotCollector | null = null;
let _config: ServiceEventsConfig | null = null;

/**
 * Get the route pattern from a Koa context.
 *
 * Tries ctx._matchedRoute (set by koa-router), then ctx.routePath,
 * then falls back to ctx.path.
 */
function getRoutePattern(ctx: any): string {
  // koa-router sets _matchedRoute
  if (ctx._matchedRoute) {
    return ctx._matchedRoute;
  }
  // @koa/router may set routePath
  if (ctx.routePath) {
    return ctx.routePath;
  }
  // Fallback to raw path
  return ctx.path || '/unknown';
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
 * Resolve a module from the user's application context.
 */
function requireFromApp(moduleName: string): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createRequire } = require('module');
  const appRequire = createRequire(require.main?.filename || process.cwd() + '/');
  return appRequire(moduleName);
}

/**
 * Install Koa instrumentation hooks.
 *
 * Monkey-patches Koa.prototype.listen to prepend ServiceEvents middleware.
 *
 * @returns true if Koa was found and hooks were installed, false otherwise.
 */
export function installKoaHooks(
  endpointCollector?: EndpointMetricCollector,
  incidentSnapshotCollector?: IncidentSnapshotCollector,
  _serviceName?: string,
  config?: ServiceEventsConfig | null
): boolean {
  _endpointCollector = endpointCollector ?? null;
  _incidentSnapshotCollector = incidentSnapshotCollector ?? null;
  _config = config ?? null;

  let Koa: any;
  try {
    Koa = requireFromApp('koa');
  } catch {
    diag.debug('Koa not installed, skipping Koa instrumentation');
    return false;
  }

  // Patch Koa.prototype.listen
  const KoaProto = Koa.prototype || Koa.default?.prototype;
  if (!KoaProto || KoaProto.__serviceeventsPatched) {
    return false;
  }

  const originalListen = KoaProto.listen;
  KoaProto.listen = function patchedListen(this: any, ...args: any[]) {
    // Install middleware when app starts listening.
    // Wrap in try/catch so a middleware-install failure can NEVER prevent the
    // customer's server from starting — telemetry must fail open. The throw
    // would otherwise propagate synchronously out of app.listen().
    try {
      installKoaMiddleware(this);
    } catch (err) {
      diag.error(`ServiceEvents: failed to install Koa middleware, continuing without it: ${err}`);
    }
    return originalListen.apply(this, args);
  };
  KoaProto.__serviceeventsPatched = true;

  return true;
}

/**
 * Install ServiceEvents middleware on a Koa app instance.
 * Can also be called directly if you have access to the Koa instance.
 */
export function installKoaMiddleware(app: any): void {
  if (app.__serviceeventsMiddlewareInstalled) {
    return;
  }

  // Prepend middleware to the app's middleware stack
  // We use unshift-like behavior by adding our middleware first
  const existingMiddleware = app.middleware ? [...app.middleware] : [];

  // ServiceEvents middleware — minimal per-request work.
  // Set startTime on ctx.req (Node's IncomingMessage) so the patched
  // http.ServerResponse.prototype.end can find it via this.req.
  const serviceeventsMiddleware = async (ctx: any, next: any) => {
    const startTime = performance.now();
    if (ctx.req) {
      ctx.req.__serviceeventsStartTime = startTime;
      // Claim this request so the global http.ServerResponse.prototype.end patch
      // (_processFinish) does NOT also record it — this Koa middleware is the
      // recorder for Koa requests. The middleware runs before res.end, so the claim
      // is set before the global patch runs, preventing double-counting.
      ctx.req.__serviceeventsRequestEnded = true;
    }
    let exception: Error | null = null;

    const url = ctx.path || '/';
    setCurrentOperation(url);

    try {
      await next();
    } catch (err: any) {
      // Capture the exception for telemetry ONLY. Do NOT swallow it or mutate
      // the response: re-throwing (below, after the finally block records
      // telemetry) preserves Koa's error propagation — ctx.onerror / the
      // app-level 'error' event still fire, and any status/body the thrown
      // error carries (e.g. http-errors 4xx) is honored by the customer's own
      // handling. This mirrors the Express instrumentation, which re-propagates
      // via next(err) rather than consuming the error.
      exception = err instanceof Error ? err : new Error(String(err));
    } finally {
      try {
        const durationMs = performance.now() - startTime;
        const durationNs = durationMs * 1_000_000;
        // Derive the status code for TELEMETRY ONLY — never written back to ctx.
        // On a thrown error, ctx.status has not yet been set by Koa's onerror, so
        // honor an error that carries its own HTTP status (http-errors/Boom set
        // err.status/err.statusCode), otherwise classify as 500. With no
        // exception, use the response status as-is.
        const errStatus = exception ? (exception as any).status ?? (exception as any).statusCode ?? 500 : undefined;
        const statusCode = exception ? (errStatus >= 400 ? errStatus : 500) : ctx.status ?? 200;
        const route = getRoutePattern(ctx);

        // Endpoint filter — skip recording if not tracked
        if (!_config || shouldTrackEndpoint(_config, route, ctx.method)) {
          let errorInfo: { errorType: string; functionName: string } | undefined;
          if (statusCode >= 400) {
            errorInfo = extractErrorFromCallPath(exception);
          }

          if (_endpointCollector) {
            _endpointCollector.recordRequest(route, ctx.method, statusCode, durationNs, errorInfo);
          }

          // Lazy incident snapshot — only allocate for errors or slow requests.
          // Resolve the per-endpoint latency threshold from the collector (see
          // express-instrumentation) so a sub-global LATENCY_THRESHOLDS value still trips.
          const incidentThreshold =
            _incidentSnapshotCollector?.resolveLatencyThresholdMs(ctx.method, route) ??
            _config?.incidentSnapshotDurationThresholdMs ??
            5000;
          if (_incidentSnapshotCollector && (statusCode >= 400 || durationMs > incidentThreshold)) {
            const requestData: RequestData = {
              headers: ctx.headers ?? {},
            };
            const exemplar = _incidentSnapshotCollector.processPotentialIncident(
              route,
              ctx.method,
              statusCode,
              durationMs,
              exception,
              requestData
            );
            if (exemplar && _endpointCollector) {
              _endpointCollector.recordIncidentExemplar(`${ctx.method} ${route}`, exemplar);
            }
          }
        }
      } finally {
        // This middleware's finally runs BEFORE res.end() (the global _processFinish
        // patch), having peeked the ALS call-path for the snapshot above. Own the
        // teardown here (get-and-clear + active-count decrement). Keyed on ctx.req —
        // the same Node IncomingMessage the global patch and the res.on('close') abort
        // backstop use — so the once-guard dedups across all three. Idempotent.
        endInvestigationOnce(ctx.req);
      }
    }

    // Re-throw so Koa's normal error handling runs (ctx.onerror, the app-level
    // 'error' event, and the customer's intended status/body). Telemetry has
    // already been recorded in the finally block above. This makes the SE
    // middleware transparent to the customer's error flow.
    if (exception) {
      throw exception;
    }
  };

  // Replace middleware stack: ServiceEvents first, then existing
  app.middleware = [serviceeventsMiddleware, ...existingMiddleware];

  app.__serviceeventsMiddlewareInstalled = true;
  diag.info('ServiceEvents Koa middleware installed on app');
}
