// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fastify instrumentation for ServiceEvents EndpointMetric and IncidentSnapshot events.
 *
 * Uses Fastify lifecycle hooks (onRequest, onResponse, onError) to:
 * - Track endpoint metrics (requests, duration, status codes)
 * - Trigger incident snapshots on errors or slow requests
 * - Propagate endpoint context to function monitors
 */

import { diag } from '@opentelemetry/api';
import { setCurrentOperation, clearCurrentOperation, ServiceEventsMonitorState } from '../serviceevents-monitor';
import { EndpointMetricCollector } from '../collectors/endpoint-collector';
import { IncidentSnapshotCollector, RequestData } from '../collectors/incident-snapshot-collector';
import { ServiceEventsConfig, shouldTrackEndpoint } from '../config';
import { endRequest } from '../profiler/request-tracker';

// Global references to collectors
let _endpointCollector: EndpointMetricCollector | null = null;
let _incidentSnapshotCollector: IncidentSnapshotCollector | null = null;
let _config: ServiceEventsConfig | null = null;

/**
 * Get the route pattern from a Fastify request.
 */
function getRoutePattern(request: any): string {
  // Fastify 4+ uses routeOptions.url
  if (request.routeOptions?.url) {
    return request.routeOptions.url;
  }
  // Fastify 3 uses routerPath
  if (request.routerPath) {
    return request.routerPath;
  }
  // Fallback to raw URL path
  return request.url || '/unknown';
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
 * Resolve a module path from the user's application context.
 */
function resolveFromApp(moduleName: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createRequire } = require('module');
  const appRequire = createRequire(require.main?.filename || process.cwd() + '/');
  return appRequire.resolve(moduleName);
}

/**
 * Install Fastify instrumentation hooks.
 *
 * Monkey-patches the Fastify factory to add lifecycle hooks to every new instance.
 *
 * @returns true if Fastify was found and hooks were installed, false otherwise.
 */
export function installFastifyHooks(
  endpointCollector?: EndpointMetricCollector,
  incidentSnapshotCollector?: IncidentSnapshotCollector,
  _serviceName?: string,
  config?: ServiceEventsConfig | null
): boolean {
  _endpointCollector = endpointCollector ?? null;
  _incidentSnapshotCollector = incidentSnapshotCollector ?? null;
  _config = config ?? null;

  let fastify: any;
  try {
    fastify = requireFromApp('fastify');
  } catch {
    diag.debug('Fastify not installed, skipping Fastify instrumentation');
    return false;
  }

  // Store original fastify factory
  const originalFastify = fastify.default || fastify;

  // Create wrapped factory
  const wrappedFastify = function serviceeventsFastify(...args: any[]) {
    const instance = originalFastify(...args);
    installFastifyLifecycleHooks(instance);
    return instance;
  };

  // Copy properties from original
  Object.keys(originalFastify).forEach(key => {
    (wrappedFastify as any)[key] = originalFastify[key];
  });

  // Replace in module cache
  try {
    const fastifyPath = resolveFromApp('fastify');
    if (require.cache[fastifyPath]) {
      require.cache[fastifyPath]!.exports = wrappedFastify;
      require.cache[fastifyPath]!.exports.default = wrappedFastify;
    }
  } catch (err) {
    diag.warn(`Could not patch Fastify module cache: ${err}`);
  }

  return true;
}

/**
 * Install ServiceEvents lifecycle hooks on a Fastify instance.
 * Can also be called directly if you have access to the Fastify instance.
 */
export function installFastifyLifecycleHooks(instance: any): void {
  if (instance.__serviceeventsHooksInstalled) {
    return;
  }

  // onRequest: minimal per-request work — just start time + endpoint context.
  // Set startTime on request.raw (Node's IncomingMessage) so the patched
  // http.ServerResponse.prototype.end can find it via this.req.
  instance.addHook('onRequest', (request: any, reply: any, done: any) => {
    const startTime = performance.now();
    request.__serviceeventsStartTime = startTime;
    if (request.raw) request.raw.__serviceeventsStartTime = startTime;
    const url = request.url || '/';
    const qIdx = url.indexOf('?');
    setCurrentOperation(qIdx >= 0 ? url.substring(0, qIdx) : url);
    done();
  });

  // onError: capture exception
  instance.addHook('onError', (request: any, reply: any, error: any, done: any) => {
    request.__serviceeventsException = error;
    done();
  });

  // onResponse: record metrics and process incidents
  instance.addHook('onResponse', (request: any, reply: any, done: any) => {
    try {
      const startTime = request.__serviceeventsStartTime;
      if (!startTime) {
        done();
        return;
      }

      const durationMs = performance.now() - startTime;
      const durationNs = durationMs * 1_000_000;
      const statusCode = reply.statusCode;
      const route = getRoutePattern(request);

      // Profiler sample→operation correlation. Fastify resolves routes post-hoc
      // so we push here (not at onRequest). Last-write-wins in the ring if
      // the universal res.end hook also pushed with a less-specific route.
      const rawReq = request.raw ?? request;
      const seq = rawReq.__serviceeventsSeq;
      if (typeof seq === 'number') {
        rawReq.__serviceeventsRequestEnded = true;
        try {
          const startNs = rawReq.__serviceeventsStartNs ?? Date.now() * 1_000_000 - durationMs * 1_000_000;
          const endNs = Date.now() * 1_000_000;
          endRequest(seq, `${request.method} ${route}`, startNs, endNs);
        } catch {
          // Best-effort
        }
      }

      // Endpoint filter
      if (_config && !shouldTrackEndpoint(_config, route, request.method)) {
        done();
        return;
      }

      // Extract error info only for error responses
      let errorInfo: { errorType: string; functionName: string } | undefined;
      if (statusCode >= 400) {
        errorInfo = extractErrorFromCallPath(request.__serviceeventsException ?? null);
      }

      // Record endpoint metric
      if (_endpointCollector) {
        _endpointCollector.recordRequest(route, request.method, statusCode, durationNs, errorInfo);
      }

      // Lazy incident snapshot — only allocate RequestData for errors or slow requests
      const incidentThreshold = _config?.incidentSnapshotDurationThresholdMs ?? 5000;
      if (_incidentSnapshotCollector && (statusCode >= 400 || durationMs > incidentThreshold)) {
        const requestData: RequestData = {
          headers: request.headers ?? {},
          args: request.query ?? {},
          viewArgs: request.params ?? {},
          cachedBody: request.body ?? null,
        };
        const exemplar = _incidentSnapshotCollector.processPotentialIncident(
          route,
          request.method,
          statusCode,
          durationMs,
          request.__serviceeventsException ?? null,
          requestData
        );
        if (exemplar && _endpointCollector) {
          _endpointCollector.recordIncidentExemplar(`${request.method} ${route}`, exemplar);
        }
      }
    } finally {
      clearCurrentOperation();
    }
    done();
  });

  instance.__serviceeventsHooksInstalled = true;
  diag.info('ServiceEvents Fastify lifecycle hooks installed');
}
