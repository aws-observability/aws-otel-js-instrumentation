// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js instrumentation for ServiceEvents EndpointMetric and IncidentSnapshot events.
 *
 * Installs hooks into Next.js's NextNodeServer to:
 * - Track endpoint metrics (requests, duration, status codes)
 * - Trigger incident snapshots on errors or slow requests
 * - Propagate endpoint context to function monitors
 *
 * Works with all Next.js server modes:
 * - `next dev` (DevServer extends NextNodeServer)
 * - `next start` (production NextNodeServer)
 * - Custom servers using the `next()` factory
 * - Standalone builds (`output: 'standalone'`)
 *
 * Route extraction strategy:
 * 1. Next.js request metadata via Symbol.for('NextRequestMeta') — set after routing
 * 2. `x-matched-path` header — set by Next.js middleware rewrites
 * 3. Fallback to raw URL path (stripped of query string)
 */

import { diag } from '@opentelemetry/api';
import { setCurrentOperation } from '../serviceevents-monitor';
import { EndpointMetricCollector } from '../collectors/endpoint-collector';
import { IncidentSnapshotCollector, RequestData } from '../collectors/incident-snapshot-collector';
import { ServiceEventsConfig, shouldTrackEndpoint } from '../config';
import { endInvestigationOnce, extractErrorFromCallPath } from './express-instrumentation';

// Global references to collectors
let _endpointCollector: EndpointMetricCollector | null = null;
let _incidentSnapshotCollector: IncidentSnapshotCollector | null = null;
let _config: ServiceEventsConfig | null = null;

// Symbol used by Next.js to store request metadata on IncomingMessage.
// Next.js uses Symbol.for() so it is shared across module instances.
const NEXT_REQUEST_META = Symbol.for('NextRequestMeta');

// Next.js internal route prefixes that should be excluded from endpoint metrics.
// These are static assets, image optimization, and internal Next.js routes.
const NEXTJS_INTERNAL_PREFIXES = ['/_next/', '/__nextjs_original-stack-frame'];

/**
 * Check if a route is a Next.js internal route (static assets, etc.).
 */
function isNextJsInternalRoute(route: string): boolean {
  return NEXTJS_INTERNAL_PREFIXES.some(prefix => route.startsWith(prefix));
}

/**
 * Get the route pattern from a Next.js request.
 *
 * Tries multiple strategies to extract the parameterized route pattern
 * (e.g., `/api/users/[id]`) from the request, falling back to the raw
 * URL path if no route pattern is available.
 *
 * Route extraction is performed AFTER the request has been handled by
 * Next.js so that routing metadata is populated on the request object.
 */
function getRoutePattern(req: any): string {
  // Strategy 1: Next.js request metadata (most reliable)
  // Next.js stores routing info on the request via Symbol.for('NextRequestMeta').
  // After route matching, this contains the matched route definition.
  try {
    const meta = req[NEXT_REQUEST_META];
    if (meta) {
      // App Router & Pages Router: matched route definition pathname
      if (meta.match?.definition?.pathname) {
        return meta.match.definition.pathname;
      }
      // __nextPathnameInfo may contain the resolved page
      if (meta.__nextPathnameInfo?.page) {
        return meta.__nextPathnameInfo.page;
      }
    }
  } catch {
    // Ignore — try next strategy
  }

  // Strategy 2: req.page (Pages Router — set during rendering)
  try {
    if (req.page?.name) {
      return req.page.name;
    }
  } catch {
    // Ignore
  }

  // Strategy 3: x-matched-path header (set by Next.js middleware rewrites)
  try {
    const matchedPath = req.headers?.['x-matched-path'];
    if (matchedPath && typeof matchedPath === 'string') {
      return matchedPath;
    }
  } catch {
    // Ignore
  }

  // Fallback: raw URL path with query string stripped
  const url = req.url || '/';
  return url.split('?')[0] || '/';
}

/**
 * Resolve a module from the user's application context rather than the ADOT package.
 */
function requireFromApp(moduleName: string): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createRequire } = require('module');
  const appRequire = createRequire(require.main?.filename || process.cwd() + '/');
  return appRequire(moduleName);
}

/**
 * Install Next.js instrumentation hooks.
 *
 * Patches `NextNodeServer.prototype.handleRequest` so that every HTTP
 * request processed by Next.js gets ServiceEvents endpoint tracking and
 * incident snapshot evaluation.
 *
 * The hook is installed on the prototype, so it applies to all instances
 * including `DevServer` (which extends `NextNodeServer`).
 *
 * @returns true if Next.js was found and hooks were installed, false otherwise.
 */
export function installNextJsHooks(
  endpointCollector?: EndpointMetricCollector,
  incidentSnapshotCollector?: IncidentSnapshotCollector,
  _serviceName?: string,
  config?: ServiceEventsConfig | null
): boolean {
  _endpointCollector = endpointCollector ?? null;
  _incidentSnapshotCollector = incidentSnapshotCollector ?? null;
  _config = config ?? null;

  // Try to load NextNodeServer from next/dist/server/next-server
  let NextNodeServer: any;
  try {
    const mod = requireFromApp('next/dist/server/next-server');
    NextNodeServer = mod.default || mod;
  } catch {
    diag.debug('Next.js not installed, skipping Next.js instrumentation');
    return false;
  }

  if (!NextNodeServer?.prototype) {
    diag.debug('NextNodeServer prototype not found, skipping Next.js instrumentation');
    return false;
  }

  const proto = NextNodeServer.prototype;
  if (proto.__serviceeventsPatched) {
    return true;
  }

  // Find handleRequest — the main request entry point for all Next.js servers.
  const origHandleRequest = proto.handleRequest;
  if (typeof origHandleRequest !== 'function') {
    diag.debug('NextNodeServer.handleRequest not found, skipping Next.js instrumentation');
    return false;
  }

  try {
    proto.handleRequest = async function serviceeventsNextJsHandleRequest(
      this: any,
      req: any,
      res: any,
      parsedUrl?: any
    ): Promise<void> {
      // Determine early route from parsed URL or raw URL
      const earlyRoute = parsedUrl?.pathname || req.url?.split('?')[0] || '/';

      // Skip Next.js internal routes (static assets, image optimization, etc.)
      if (isNextJsInternalRoute(earlyRoute)) {
        return origHandleRequest.call(this, req, res, parsedUrl);
      }

      const startTime = performance.now();
      const method = req.method || 'GET';

      // Set startTime on raw request + endpoint context
      req.__serviceeventsStartTime = startTime;
      // Claim this request so the global http.ServerResponse.prototype.end patch
      // (_processFinish) does NOT also record it — this handleRequest wrapper is the
      // recorder for Next.js requests. It runs before res.end, so the claim is set
      // before the global patch runs, preventing double-counting.
      req.__serviceeventsRequestEnded = true;
      setCurrentOperation(earlyRoute);

      let caughtException: Error | null = null;

      try {
        return await origHandleRequest.call(this, req, res, parsedUrl);
      } catch (err: any) {
        caughtException = err;
        throw err;
      } finally {
        try {
          const durationMs = performance.now() - startTime;
          const durationNs = durationMs * 1_000_000;
          const statusCode = res.statusCode || 500;
          const route = getRoutePattern(req);

          // Endpoint filter — skip recording if not tracked
          if (!_config || shouldTrackEndpoint(_config, route, method)) {
            let errorInfo: { errorType: string; functionName: string } | undefined;
            if (statusCode >= 400 || caughtException) {
              errorInfo = extractErrorFromCallPath(caughtException);
            }

            if (_endpointCollector) {
              _endpointCollector.recordRequest(route, method, statusCode, durationNs, errorInfo);
            }

            // Resolve the per-endpoint latency threshold from the collector (see
            // express-instrumentation) so a sub-global LATENCY_THRESHOLDS value still trips.
            const incidentThreshold =
              _incidentSnapshotCollector?.resolveLatencyThresholdMs(method, route) ??
              _config?.incidentSnapshotDurationThresholdMs ??
              5000;
            if (_incidentSnapshotCollector && (statusCode >= 400 || durationMs > incidentThreshold)) {
              const requestData: RequestData = {
                headers: req.headers ?? {},
              };
              const exemplar = _incidentSnapshotCollector.processPotentialIncident(
                route,
                method,
                statusCode,
                durationMs,
                caughtException,
                requestData
              );
              if (exemplar && _endpointCollector) {
                _endpointCollector.recordIncidentExemplar(`${method} ${route}`, exemplar);
              }
            }
          }
        } finally {
          // This wrapper's finally runs as origHandleRequest (which calls res.end())
          // settles — having peeked the ALS call-path for the snapshot above. Own the
          // teardown here (get-and-clear + active-count decrement). Keyed on req — the
          // same Node IncomingMessage the global _processFinish patch and the
          // res.on('close') abort backstop use — so the once-guard dedups across all
          // three. Idempotent.
          endInvestigationOnce(req);
        }
      }
    };

    proto.__serviceeventsPatched = true;
    diag.info('Next.js instrumentation hooks installed on NextNodeServer.prototype.handleRequest');
    return true;
  } catch (err) {
    diag.error(`Failed to install Next.js instrumentation: ${err}`);
    return false;
  }
}
