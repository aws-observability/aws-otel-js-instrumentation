// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Framework-agnostic endpoint span processor for ServiceEvents.
 *
 * This is the Node.js port of the Java agent's `ServiceEventsSpanProcessor` (and the
 * counterpart of the Python `ServiceEventsSpanProcessor`). Instead of installing
 * per-framework hooks (Express/Fastify/Koa/Next.js), it reads the request-boundary span that
 * OpenTelemetry's own HTTP/framework instrumentation already produces and derives the same
 * endpoint metric + incident telemetry from span attributes alone. Any framework OTel
 * instruments for free is then covered without bespoke hook code.
 *
 * Mapping to the Java design (`ServiceEventsSpanProcessor.java`):
 *
 * - `onEnd` filters to the request boundary (SERVER or local-root), derives the operation
 *   with the SHARED App Signals `AwsSpanProcessingUtil.getIngressOperation` (span-name
 *   primary, first-path-segment fallback) — byte-identical to Java line 202 and to the
 *   per-framework hooks for matched routes — then drives the unchanged `EndpointMetricCollector`
 *   and `IncidentSnapshotCollector`.
 * - `onStart` fires the *begin signal* (`beginInvestigation`) for the request-boundary span,
 *   exactly like the Python port's `on_start`. This is mandatory for exception attribution on
 *   handler-swallowed 5xx (a global error handler converts an exception to a 500 *before* the
 *   span records an `exception` event), where the AST function-monitor's captured call-path is
 *   the only surviving record of the error. An `AsyncLocalStorage.enterWith` issued here
 *   propagates to both the request handler and `onEnd` — verified empirically against
 *   `instrumentation-http` (the SERVER span's `onStart` runs at the head of the request's async
 *   subtree, so the begin is visible everywhere downstream). Because of this, span-processor
 *   mode does NOT install `installGlobalHttpPatches`; the processor owns the whole begin→end
 *   lifecycle itself, mirroring Python and avoiding the global patch's `res.on('close')`
 *   teardown racing ahead of `onEnd`.
 *
 * The collectors are reused verbatim: both rebuild `operation = `${method} ${route}`` internally
 * and hold the fault-only (`status >= 500 && errorInfo`) breakdown gate, so this processor passes
 * scalar `route`/`method` and lets that shared layer do the rest. Route is backed out of the
 * App Signals operation so the rebuilt operation is identical to what App Signals reports.
 */

import { diag } from '@opentelemetry/api';
import { hrTimeToMilliseconds, hrTimeToNanoseconds } from '@opentelemetry/core';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanKind } from '@opentelemetry/api';
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_STATUS_CODE,
} from '@opentelemetry/semantic-conventions';
import { AwsSpanProcessingUtil } from '../../aws-span-processing-util';
import { EndpointMetricCollector } from '../collectors/endpoint-collector';
import { IncidentSnapshotCollector, RequestData } from '../collectors/incident-snapshot-collector';
import { ServiceEventsConfig, shouldTrackEndpoint } from '../config';
import { extractErrorFromCallPath } from '../instrumentation/express-instrumentation';
import { ServiceEventsMonitorState, setCurrentOperation, clearCurrentOperation } from '../serviceevents-monitor';

/** HTTP method from the span: stable `http.request.method` first, legacy `http.method`. */
export function getHttpMethod(span: ReadableSpan): string | undefined {
  const method = span.attributes[ATTR_HTTP_REQUEST_METHOD] ?? span.attributes[SEMATTRS_HTTP_METHOD];
  return typeof method === 'string' ? method : undefined;
}

/**
 * Recover an exception from the span's own OTel `exception` event.
 *
 * The AST function-monitor only captures an exception when the throw unwinds through an
 * instrumented frame. A 5xx thrown in uninstrumented library code, or swallowed by a framework
 * global handler that converts it to a 500 *before* it reaches any instrumented frame, leaves the
 * investigation data empty — yet OTel's own instrumentation still records an `exception` event on
 * the span (`span.recordException`). Java's `ServiceEventsSpanProcessor` reads that event as its
 * exception source; this is the Node.js equivalent.
 *
 * Returns an object shaped like the monitor's captured exception so it can seed the investigation
 * data and flow through the unchanged breakdown + snapshot recovery paths, or undefined when the
 * span has no exception event.
 */
export function exceptionFromSpanEvent(
  span: ReadableSpan
): { name: string; message: string; traceback: string; functionName: string } | undefined {
  const events = span.events;
  if (!events || events.length === 0) {
    return undefined;
  }
  // Last exception event wins — it is the one closest to the response being produced.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.name !== 'exception') {
      continue;
    }
    const attributes = event.attributes ?? {};
    const excType = attributes[ATTR_EXCEPTION_TYPE];
    if (typeof excType !== 'string' || excType.length === 0) {
      continue;
    }
    const message = attributes[ATTR_EXCEPTION_MESSAGE];
    const stacktrace = attributes[ATTR_EXCEPTION_STACKTRACE];
    return {
      name: excType,
      message: typeof message === 'string' ? message : '',
      traceback: typeof stacktrace === 'string' ? stacktrace : '',
      // The span event carries no origin function; 'unknown' matches the breakdown's fallback
      // when no instrumented frame recorded the throw.
      functionName: 'unknown',
    };
  }
  return undefined;
}

/**
 * HTTP status from the span: stable `http.response.status_code` first, legacy `http.status_code`.
 * Returns 0 when neither is present (mirrors Java's `statusCode = 0` default), which the
 * collectors treat as a non-fault, non-error.
 */
export function getStatusCode(span: ReadableSpan): number {
  const raw = span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] ?? span.attributes[SEMATTRS_HTTP_STATUS_CODE];
  if (raw === undefined) {
    return 0;
  }
  const parsed = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * True for the span that delimits an inbound request. Matches Java's filter
 * (`getKind() != SERVER && !isLocalRoot` → skip): a SERVER span, or any local-root span.
 * `AwsSpanProcessingUtil.isLocalRoot` reads the `aws.is.local.root` attribute precalculated by
 * AttributePropagatingSpanProcessor, so this requires that processor to run first (it always
 * does — the configurator registers it ahead of every other processor).
 */
export function isRequestBoundary(span: ReadableSpan): boolean {
  return span.kind === SpanKind.SERVER || AwsSpanProcessingUtil.isLocalRoot(span);
}

/**
 * Back the route out of the App Signals operation so the unchanged collector rebuilds the
 * identical `${method} ${route}` operation. Returns undefined when the operation has no
 * resolvable HTTP route (InternalOperation / UnknownOperation / a lambda handler / a bare
 * method), so the caller skips — matching Java's `route == null` early return.
 */
export function routeFromOperation(operation: string | undefined, method: string): string | undefined {
  if (!operation) {
    return undefined;
  }
  if (operation === AwsSpanProcessingUtil.INTERNAL_OPERATION || operation === AwsSpanProcessingUtil.UNKNOWN_OPERATION) {
    return undefined;
  }
  if (operation === method) {
    // span name was just the bare HTTP method — no route.
    return undefined;
  }
  const prefix = `${method} `;
  if (operation.startsWith(prefix)) {
    const route = operation.slice(prefix.length);
    return route.length > 0 ? route : undefined;
  }
  if (operation.startsWith('/')) {
    // Bare path with no method prefix — the collector re-prepends the method.
    return operation;
  }
  // Anything else (e.g. "name/FunctionHandler") is not an HTTP route.
  return undefined;
}

/**
 * SpanProcessor that produces ServiceEvents endpoint + incident telemetry from spans.
 *
 * Crash-safe by contract: a telemetry failure must never disrupt application tracing, so
 * `onEnd` swallows every exception.
 */
export class ServiceEventsSpanProcessor implements SpanProcessor {
  constructor(
    private readonly endpointCollector: EndpointMetricCollector | null,
    private readonly incidentSnapshotCollector: IncidentSnapshotCollector | null,
    private readonly config: ServiceEventsConfig | null
  ) {}

  /**
   * Begin investigation for the request-boundary span only.
   *
   * This is the generic begin hook (the Node.js analogue of Python's `on_start` and of Java's
   * bytecode servlet advice). The `enterWith` inside `beginInvestigation` propagates to the
   * request handler and to `onEnd` because the SERVER span's `onStart` runs at the head of the
   * request's async subtree. Gated to the request boundary because each boundary span owns exactly
   * one begin→end pair, and the matching `onEnd` uses the identical gate so the begin/end
   * active-count stays balanced (a local-root CLIENT span that begins here must also end here).
   *
   * `forceNew` is mandatory in span-processor mode: a keep-alive socket reuses its async context
   * across sequential requests, so the previous request's `enterWith({...})` leaks forward and the
   * next request's `onStart` sees a stale non-null store. The create-only default would skip the
   * increment there while `onEnd` still decrements — drifting `_investigationActiveCount` below
   * zero and silently disabling exception capture from the second request on. A forced fresh store
   * resets the leaked call-path/exception and keeps every begin paired with its `onEnd` decrement.
   */
  onStart(span: Span): void {
    try {
      if (!isRequestBoundary(span)) {
        return;
      }
      ServiceEventsMonitorState.getInstance().beginInvestigation(true);
    } catch (err) {
      diag.debug('ServiceEvents endpoint span processor onStart failed', err);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      if (!isRequestBoundary(span)) {
        return;
      }
      // The request is ending. Own teardown atomically (mirrors Java onEnd's finally and the
      // Python port's on_end): record first while the investigation call-path is still present,
      // then clear the per-request investigation + operation so they can't leak onto the next
      // request that reuses this async context. getInvestigationData() also decrements the
      // active-count begun in onStart — the gate here is identical to onStart's, so the count
      // stays balanced even for local-root CLIENT spans (which begin+end but record nothing).
      // This runs in the request's async context (instrumentation-http ends the SERVER span
      // inside the request's async subtree), so the ALS reads/writes hit the correct store.
      try {
        this.processRequestSpan(span);
      } finally {
        ServiceEventsMonitorState.getInstance().getInvestigationData();
        clearCurrentOperation();
      }
    } catch (err) {
      diag.debug('ServiceEvents endpoint span processor onEnd failed', err);
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Seed the span's recorded exception into the investigation data (first-writer-wins).
   *
   * Only fills the exception when the AST monitor captured none, so an instrumented throw's origin
   * function (which the span event lacks) is always preferred. No-ops when the span has no
   * exception event or no investigation context exists.
   */
  private seedExceptionFromSpan(span: ReadableSpan): void {
    const invData = ServiceEventsMonitorState.getInstance().peekInvestigationData();
    if (!invData || invData.exception) {
      return;
    }
    const spanException = exceptionFromSpanEvent(span);
    if (spanException) {
      invData.exception = spanException;
    }
  }

  private processRequestSpan(span: ReadableSpan): void {
    const method = getHttpMethod(span);
    if (!method) {
      // No HTTP method → not an inbound HTTP request boundary (e.g. a messaging consumer
      // local-root). Java skips these too (method == null early return).
      return;
    }

    // Derive the operation exactly as App Signals / the Java processor do, then back the
    // route out of it so the unchanged collectors rebuild the identical operation string.
    const operation = AwsSpanProcessingUtil.getIngressOperation(span);
    const route = routeFromOperation(operation, method);
    if (!route) {
      return;
    }

    // Apply the user-configured endpoint include/exclude filters — same gate the
    // per-framework hooks and Java's EndpointFilter apply.
    if (this.config && !shouldTrackEndpoint(this.config, route, method)) {
      return;
    }

    const statusCode = getStatusCode(span);
    const durationNs = hrTimeToNanoseconds(span.duration);
    const durationMs = hrTimeToMilliseconds(span.duration);

    // Fault recovery from the span's own exception event. When a 5xx unwound through code the AST
    // monitor never instrumented (library internals, or a global handler that converted the error
    // to a 500 before any instrumented frame saw it), the investigation data holds no exception.
    // OTel still recorded an `exception` event on the span, so seed it into the investigation data
    // here — first-writer-wins, so a real AST-captured exception is never overwritten. Both the
    // breakdown and the snapshot recover the exception from that same investigation data, matching
    // Java which reads the span event directly.
    if (statusCode >= 500) {
      this.seedExceptionFromSpan(span);
    }

    // Error info from the AST monitor's captured call-path (now also seeded from the span event
    // for uninstrumented faults). extractErrorFromCallPath PEEKS (does not clear) so the incident
    // collector can still consume the investigation data. null exception is correct: like Java,
    // the original Error object is gone by span end; the captured type/origin live in the
    // investigation data.
    let errorInfo: { errorType: string; functionName: string } | undefined;
    if (statusCode >= 400) {
      errorInfo = extractErrorFromCallPath(null);
    }

    // 1. Endpoint metric.
    if (this.endpointCollector) {
      this.endpointCollector.recordRequest(route, method, statusCode, durationNs, errorInfo);
    }

    // Set current operation before the incident path so exemplar correlation matches the
    // recorded aggregation key (mirrors Java onEnd line 241).
    setCurrentOperation(operation as string);

    // 2. Potential incident. Resolve the per-endpoint latency threshold so a route with a
    // sub-global LATENCY_THRESHOLDS value still trips the gate. exception=null: the trigger
    // gate uses statusCode >= 500, and exception detail is recovered from investigation data
    // inside the collector, exactly as Java does.
    if (this.incidentSnapshotCollector) {
      const incidentThreshold =
        this.incidentSnapshotCollector.resolveLatencyThresholdMs(method, route) ??
        this.config?.incidentSnapshotDurationThresholdMs ??
        5000;
      if (statusCode >= 400 || durationMs > incidentThreshold) {
        const requestData: RequestData = { headers: {} };
        const exemplar = this.incidentSnapshotCollector.processPotentialIncident(
          route,
          method,
          statusCode,
          durationMs,
          null,
          requestData
        );
        if (exemplar && this.endpointCollector) {
          this.endpointCollector.recordIncidentExemplar(`${method} ${route}`, exemplar);
        }
      }
    }
    // No teardown here: onEnd's finally clears the operation + investigation data atomically.
  }
}
