// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, HrTime, SpanContext, SpanKind } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_PATH,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_STATUS_CODE,
  SEMATTRS_HTTP_TARGET,
} from '@opentelemetry/semantic-conventions';
import { expect } from 'expect';
import * as sinon from 'sinon';
import { AWS_ATTRIBUTE_KEYS } from '../../../src/aws-attribute-keys';
import {
  ServiceEventsSpanProcessor,
  exceptionFromSpanEvent,
  extractFunctionFromStackTrace,
  getHttpMethod,
  getStatusCode,
  isRequestBoundary,
  routeFromOperation,
} from '../../../src/serviceevents/processor/endpoint-span-processor';
import { ServiceEventsConfig } from '../../../src/serviceevents/config';
import * as monitor from '../../../src/serviceevents/serviceevents-monitor';
import * as errorExtraction from '../../../src/serviceevents/processor/error-extraction';

/**
 * Build a fake ReadableSpan. `localRoot` controls the parentSpanContext:
 * - true/undefined: parentSpanContext is undefined (no parent = local root)
 * - false: parentSpanContext is a valid local (non-remote) parent (= NOT a local root)
 *
 * A SERVER span is a boundary regardless of localRoot; a non-SERVER span is a
 * boundary only when localRoot is true.
 */
function buildSpan(opts: {
  attributes?: Attributes;
  kind?: SpanKind;
  name?: string;
  localRoot?: boolean;
  duration?: HrTime;
  events?: Array<{ name: string; attributes?: Attributes }>;
}): ReadableSpan {
  const attributes: Attributes = { ...(opts.attributes ?? {}) };
  if (opts.localRoot !== undefined) {
    attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT] = opts.localRoot;
  }
  const spanContext: SpanContext = {
    traceId: '00000000000000000000000000000008',
    spanId: '0000000000000009',
    traceFlags: 1,
  };
  // localRoot=false means the span has a valid local (non-remote) parent — NOT a local root.
  // localRoot=true or undefined means no parent (or invalid parent) — IS a local root.
  const parentCtx: SpanContext | undefined =
    opts.localRoot === false
      ? { traceId: '00000000000000000000000000000008', spanId: '0000000000000001', traceFlags: 1, isRemote: false }
      : undefined;
  return {
    name: opts.name ?? 'GET /users/:id',
    kind: opts.kind ?? SpanKind.SERVER,
    spanContext: () => spanContext,
    parentSpanContext: parentCtx,
    startTime: [0, 0],
    endTime: [0, 5_000_000],
    status: { code: 0 },
    attributes,
    links: [],
    events: opts.events ?? [],
    duration: opts.duration ?? [0, 5_000_000], // 5 ms
    ended: true,
    resource: undefined as any,
    instrumentationScope: { name: 'opentelemetry.instrumentation.http' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

describe('ServiceEventsSpanProcessor', () => {
  // getIngressOperation short-circuits to "<fn>/FunctionHandler" when AWS_LAMBDA_FUNCTION_NAME is
  // set (isLambdaEnvironment). Other test files in the suite set it without cleanup, which would
  // make every operation here back out to undefined and skip recording — so neutralize it for
  // these tests and restore afterward.
  let savedLambdaFn: string | undefined;
  beforeEach(() => {
    savedLambdaFn = process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  afterEach(() => {
    sinon.restore();
    monitor.resetMonitorState();
    if (savedLambdaFn === undefined) {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    } else {
      process.env.AWS_LAMBDA_FUNCTION_NAME = savedLambdaFn;
    }
  });

  describe('isRequestBoundary', () => {
    it('SERVER span is a boundary even when not a local root', () => {
      expect(isRequestBoundary(buildSpan({ kind: SpanKind.SERVER, localRoot: false }))).toBe(true);
    });

    it('local-root non-SERVER span is a boundary', () => {
      expect(isRequestBoundary(buildSpan({ kind: SpanKind.INTERNAL, localRoot: true }))).toBe(true);
    });

    it('non-local-root INTERNAL child span is NOT a boundary', () => {
      expect(isRequestBoundary(buildSpan({ kind: SpanKind.INTERNAL, localRoot: false }))).toBe(false);
    });

    it('non-local-root CLIENT child span is NOT a boundary', () => {
      expect(isRequestBoundary(buildSpan({ kind: SpanKind.CLIENT, localRoot: false }))).toBe(false);
    });
  });

  describe('getHttpMethod', () => {
    it('prefers the stable http.request.method key', () => {
      const span = buildSpan({
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'POST', [SEMATTRS_HTTP_METHOD]: 'GET' },
      });
      expect(getHttpMethod(span)).toBe('POST');
    });

    it('falls back to the legacy http.method key', () => {
      expect(getHttpMethod(buildSpan({ attributes: { [SEMATTRS_HTTP_METHOD]: 'GET' } }))).toBe('GET');
    });

    it('is undefined when absent', () => {
      expect(getHttpMethod(buildSpan({}))).toBeUndefined();
    });

    it('is undefined when not a string', () => {
      expect(getHttpMethod(buildSpan({ attributes: { [ATTR_HTTP_REQUEST_METHOD]: 123 as any } }))).toBeUndefined();
    });
  });

  describe('getStatusCode', () => {
    it('prefers the stable http.response.status_code key', () => {
      const span = buildSpan({
        attributes: { [ATTR_HTTP_RESPONSE_STATUS_CODE]: 503, [SEMATTRS_HTTP_STATUS_CODE]: 200 },
      });
      expect(getStatusCode(span)).toBe(503);
    });

    it('falls back to the legacy http.status_code key', () => {
      expect(getStatusCode(buildSpan({ attributes: { [SEMATTRS_HTTP_STATUS_CODE]: 404 } }))).toBe(404);
    });

    it('parses a numeric string', () => {
      expect(getStatusCode(buildSpan({ attributes: { [ATTR_HTTP_RESPONSE_STATUS_CODE]: '500' as any } }))).toBe(500);
    });

    it('is 0 when absent', () => {
      expect(getStatusCode(buildSpan({}))).toBe(0);
    });

    it('is 0 when unparseable', () => {
      expect(getStatusCode(buildSpan({ attributes: { [ATTR_HTTP_RESPONSE_STATUS_CODE]: 'nope' as any } }))).toBe(0);
    });
  });

  describe('routeFromOperation', () => {
    it('strips the "{method} " prefix', () => {
      expect(routeFromOperation('GET /api/orders/{id}', 'GET')).toBe('/api/orders/{id}');
    });

    it('returns a bare path verbatim (stable-method-only span)', () => {
      expect(routeFromOperation('/wp-admin', 'GET')).toBe('/wp-admin');
    });

    it('returns undefined for InternalOperation', () => {
      expect(routeFromOperation('InternalOperation', 'GET')).toBeUndefined();
    });

    it('returns undefined for UnknownOperation', () => {
      expect(routeFromOperation('UnknownOperation', 'GET')).toBeUndefined();
    });

    it('returns undefined for a bare method (span name == method)', () => {
      expect(routeFromOperation('GET', 'GET')).toBeUndefined();
    });

    it('returns undefined for a lambda handler operation', () => {
      expect(routeFromOperation('my-fn/FunctionHandler', 'GET')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(routeFromOperation(undefined, 'GET')).toBeUndefined();
    });

    it('returns undefined when the prefix strip leaves an empty route', () => {
      // Operation is exactly "GET " (method + trailing space, no path) -> empty route.
      expect(routeFromOperation('GET ', 'GET')).toBeUndefined();
    });
  });

  describe('onStart', () => {
    let processor: ServiceEventsSpanProcessor;
    let beginSpy: sinon.SinonSpy;

    beforeEach(() => {
      processor = new ServiceEventsSpanProcessor(null, null, null);
      beginSpy = sinon.spy(monitor.ServiceEventsMonitorState.getInstance(), 'beginInvestigation');
    });

    it('begins investigation for the request boundary', () => {
      processor.onStart(buildSpan({ kind: SpanKind.SERVER }) as any);
      sinon.assert.calledOnce(beginSpy);
    });

    it('does NOT begin investigation for a child span', () => {
      processor.onStart(buildSpan({ kind: SpanKind.INTERNAL, localRoot: false }) as any);
      sinon.assert.notCalled(beginSpy);
    });

    it('never throws even when the monitor blows up', () => {
      beginSpy.restore();
      sinon.stub(monitor.ServiceEventsMonitorState, 'getInstance').throws(new Error('boom'));
      expect(() => processor.onStart(buildSpan({ kind: SpanKind.SERVER }) as any)).not.toThrow();
    });
  });

  describe('onEnd', () => {
    let endpointCollector: any;
    let incidentCollector: any;
    let config: ServiceEventsConfig;
    let processor: ServiceEventsSpanProcessor;
    let extractStub: sinon.SinonStub;

    beforeEach(() => {
      endpointCollector = {
        recordRequest: sinon.spy(),
        recordIncidentExemplar: sinon.spy(),
      };
      incidentCollector = {
        resolveLatencyThresholdMs: sinon.stub().returns(5000),
        processPotentialIncident: sinon.stub().returns(null),
      };
      config = { endpointIncludePatterns: [], endpointExcludePatterns: [] } as unknown as ServiceEventsConfig;
      processor = new ServiceEventsSpanProcessor(endpointCollector, incidentCollector, config);
      // Default: no captured error so error breakdown is omitted unless a test opts in.
      extractStub = sinon.stub(errorExtraction, 'extractErrorFromCallPath').returns(undefined);
    });

    it('records a matched-route request with route/method/status/duration', () => {
      const span = buildSpan({
        name: 'GET /users/:id',
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: 'GET',
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200,
        },
        duration: [0, 5_000_000],
      });
      processor.onEnd(span);
      sinon.assert.calledOnce(endpointCollector.recordRequest);
      const [route, method, status, durationNs, errorInfo] = endpointCollector.recordRequest.firstCall.args;
      expect(route).toBe('/users/:id');
      expect(method).toBe('GET');
      expect(status).toBe(200);
      expect(durationNs).toBe(5_000_000);
      expect(errorInfo).toBeUndefined();
    });

    it('backs the route out of the App Signals operation (span name)', () => {
      const span = buildSpan({
        name: 'POST /api/orders/{id}',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'POST', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 201 },
      });
      processor.onEnd(span);
      expect(endpointCollector.recordRequest.firstCall.args[0]).toBe('/api/orders/{id}');
    });

    it('collapses an unmatched route to its first path segment via the ingress op', () => {
      // Bare "GET" span name -> getIngressOperation generates "{method} {first-segment}".
      const span = buildSpan({
        name: 'GET',
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: 'GET',
          [SEMATTRS_HTTP_TARGET]: '/wp-admin/setup.php',
          [ATTR_URL_PATH]: '/wp-admin/setup.php',
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: 404,
        },
      });
      processor.onEnd(span);
      sinon.assert.calledOnce(endpointCollector.recordRequest);
      expect(endpointCollector.recordRequest.firstCall.args[0]).toBe('/wp-admin');
    });

    it('skips a span with no HTTP method', () => {
      processor.onEnd(buildSpan({ name: 'GET /x', attributes: {} }));
      sinon.assert.notCalled(endpointCollector.recordRequest);
    });

    it('skips an InternalOperation (local-root non-SERVER) span even with a method', () => {
      // A local-root non-SERVER span resolves to InternalOperation via shouldUseInternalOperation,
      // so even with an http method present the route backs out to undefined (the post-method
      // route-falsy early return).
      const span = buildSpan({
        kind: SpanKind.INTERNAL,
        localRoot: true,
        name: 'InternalOperation',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
      });
      processor.onEnd(span);
      sinon.assert.notCalled(endpointCollector.recordRequest);
    });

    it('skips a child span entirely (record + incident)', () => {
      const span = buildSpan({
        kind: SpanKind.INTERNAL,
        localRoot: false,
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET' },
        name: 'GET /x',
      });
      processor.onEnd(span);
      sinon.assert.notCalled(endpointCollector.recordRequest);
      sinon.assert.notCalled(incidentCollector.processPotentialIncident);
    });

    it('applies the endpoint include/exclude filter', () => {
      config.endpointExcludePatterns = ['GET /health'];
      const span = buildSpan({
        name: 'GET /health',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
      });
      processor.onEnd(span);
      sinon.assert.notCalled(endpointCollector.recordRequest);
    });

    it('extracts error info for a 5xx (passing null exception)', () => {
      extractStub.returns({ errorType: 'TypeError', functionName: 'handler' });
      const span = buildSpan({
        name: 'GET /boom',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500 },
      });
      processor.onEnd(span);
      sinon.assert.calledOnceWithExactly(extractStub, null);
      expect(endpointCollector.recordRequest.firstCall.args[4]).toEqual({
        errorType: 'TypeError',
        functionName: 'handler',
      });
    });

    it('does NOT extract error info for a 2xx', () => {
      const span = buildSpan({
        name: 'GET /ok',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
      });
      processor.onEnd(span);
      sinon.assert.notCalled(extractStub);
    });

    it('drives the incident path with a null exception for a 5xx', () => {
      const span = buildSpan({
        name: 'GET /boom',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500 },
      });
      processor.onEnd(span);
      sinon.assert.calledOnce(incidentCollector.processPotentialIncident);
      const [route, method, status, , exception] = incidentCollector.processPotentialIncident.firstCall.args;
      expect(route).toBe('/boom');
      expect(method).toBe('GET');
      expect(status).toBe(500);
      expect(exception).toBeNull();
    });

    it('triggers an incident on a slow 2xx that exceeds the latency threshold', () => {
      incidentCollector.resolveLatencyThresholdMs.returns(10); // 10 ms threshold
      const span = buildSpan({
        name: 'GET /slow',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
        duration: [0, 50_000_000], // 50 ms > 10 ms
      });
      processor.onEnd(span);
      sinon.assert.calledOnce(incidentCollector.processPotentialIncident);
    });

    it('falls back to the config threshold when resolveLatencyThresholdMs returns undefined', () => {
      // Exercises the `?? config.incidentSnapshotDurationThresholdMs ?? 5000` fallback chain.
      incidentCollector.resolveLatencyThresholdMs.returns(undefined);
      config.incidentSnapshotDurationThresholdMs = 20; // 20 ms fallback threshold
      const span = buildSpan({
        name: 'GET /slow',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
        duration: [0, 50_000_000], // 50 ms > 20 ms fallback
      });
      processor.onEnd(span);
      sinon.assert.calledOnce(incidentCollector.processPotentialIncident);
    });

    it('uses the hardcoded 5000ms default when neither resolver nor config provides a threshold', () => {
      // Exercises the final `?? 5000` arm: resolver undefined AND config threshold undefined.
      incidentCollector.resolveLatencyThresholdMs.returns(undefined);
      (config as any).incidentSnapshotDurationThresholdMs = undefined;
      const fast = buildSpan({
        name: 'GET /fast',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
        duration: [0, 10_000_000], // 10 ms < 5000 ms default -> no incident
      });
      processor.onEnd(fast);
      sinon.assert.notCalled(incidentCollector.processPotentialIncident);
    });

    it('records an exemplar when the incident collector returns one', () => {
      incidentCollector.processPotentialIncident.returns({ operation: 'GET /boom', snapshotId: 'snap_1' });
      const span = buildSpan({
        name: 'GET /boom',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500 },
      });
      processor.onEnd(span);
      sinon.assert.calledOnce(endpointCollector.recordIncidentExemplar);
      expect(endpointCollector.recordIncidentExemplar.firstCall.args[0]).toBe('GET /boom');
    });

    it('clears operation + investigation data in the finally', () => {
      const clearOpSpy = sinon.spy(monitor, 'clearCurrentOperation');
      const getInvSpy = sinon.spy(monitor.ServiceEventsMonitorState.getInstance(), 'getInvestigationData');
      const span = buildSpan({
        name: 'GET /x',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
      });
      processor.onEnd(span);
      sinon.assert.calledOnce(clearOpSpy);
      sinon.assert.calledOnce(getInvSpy);
    });

    it('clears context even when recording throws', () => {
      endpointCollector.recordRequest = sinon.stub().throws(new Error('collector down'));
      const clearOpSpy = sinon.spy(monitor, 'clearCurrentOperation');
      const getInvSpy = sinon.spy(monitor.ServiceEventsMonitorState.getInstance(), 'getInvestigationData');
      const span = buildSpan({
        name: 'GET /x',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
      });
      expect(() => processor.onEnd(span)).not.toThrow();
      sinon.assert.calledOnce(clearOpSpy);
      sinon.assert.calledOnce(getInvSpy);
    });

    it('never throws on a child span (early return, no teardown)', () => {
      const getInvSpy = sinon.spy(monitor.ServiceEventsMonitorState.getInstance(), 'getInvestigationData');
      const span = buildSpan({ kind: SpanKind.INTERNAL, localRoot: false });
      expect(() => processor.onEnd(span)).not.toThrow();
      // A non-boundary span returns before the teardown finally — no decrement.
      sinon.assert.notCalled(getInvSpy);
    });

    it('tolerates null collectors (records nothing, still tears down)', () => {
      const bare = new ServiceEventsSpanProcessor(null, null, null);
      const getInvSpy = sinon.spy(monitor.ServiceEventsMonitorState.getInstance(), 'getInvestigationData');
      const span = buildSpan({
        name: 'GET /x',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
      });
      expect(() => bare.onEnd(span)).not.toThrow();
      sinon.assert.calledOnce(getInvSpy);
    });
  });

  describe('onStart/onEnd active-count balance', () => {
    it('begin in onStart is balanced by end in onEnd for a SERVER span', () => {
      const processor = new ServiceEventsSpanProcessor(null, null, null);
      const state = monitor.ServiceEventsMonitorState.getInstance();
      const beginSpy = sinon.spy(state, 'beginInvestigation');
      const getInvSpy = sinon.spy(state, 'getInvestigationData');
      const span = buildSpan({
        name: 'GET /x',
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
      });
      processor.onStart(span as any);
      processor.onEnd(span);
      sinon.assert.calledOnce(beginSpy);
      sinon.assert.calledOnce(getInvSpy);
    });

    it('onStart forces a fresh investigation (forceNew) so a leaked store cannot drift the count', () => {
      // Regression: a keep-alive socket reuses its async context across requests, so the previous
      // request's investigation store leaks forward and onStart sees a non-null store. With the
      // create-only default, beginInvestigation would skip the increment while onEnd still
      // decrements — pinning _investigationActiveCount at 0 and silently disabling exception
      // capture from the second request on. onStart MUST pass forceNew=true.
      const processor = new ServiceEventsSpanProcessor(null, null, null);
      const state = monitor.ServiceEventsMonitorState.getInstance();
      const beginSpy = sinon.spy(state, 'beginInvestigation');
      processor.onStart(buildSpan({ kind: SpanKind.SERVER }) as any);
      sinon.assert.calledOnceWithExactly(beginSpy, true);
    });

    it('onStart resets a stale leaked investigation instead of preserving it (forceNew)', () => {
      // The drift bug has two coupled symptoms when a previous request's investigation store leaks
      // forward onto a reused keep-alive socket context: (1) the active-count fails to rise so
      // exception capture is disabled, and (2) the stale callPath/exception would be misattributed
      // to the new request. forceNew fixes both by replacing the store with a fresh one and always
      // incrementing. Here we assert the observable half: a leaked store carrying a prior
      // exception is wiped clean by onStart, and a fresh exception is captured against it.
      monitor.registerMonitorGlobals();
      try {
        const state = monitor.ServiceEventsMonitorState.getInstance();
        // Seed a stale investigation as if it leaked from a prior request, complete with a recorded
        // exception that must NOT bleed into the new request.
        state.beginInvestigation();
        const stale = (globalThis as any).__serviceeventsMonitorEnter('staleHandler');
        (globalThis as any).__serviceeventsMonitorException(stale, new RangeError('old'));
        (globalThis as any).__serviceeventsMonitorExit(stale);
        expect(state.peekInvestigationData()?.exception?.functionName).toBe('staleHandler');

        // New request boundary arrives on the same polluted context.
        const processor = new ServiceEventsSpanProcessor(null, null, null);
        processor.onStart(buildSpan({ kind: SpanKind.SERVER }) as any);

        // forceNew replaced the store: the leaked exception/callPath are gone.
        const fresh = state.peekInvestigationData();
        expect(fresh).not.toBeNull();
        expect(fresh?.exception).toBeNull();
        expect(fresh?.callPath).toEqual([]);

        // And the active-count is lifted, so a new exception IS captured (the symptom that was
        // silently lost pre-fix once the count drifted to 0).
        const ctx = (globalThis as any).__serviceeventsMonitorEnter('boomHandler');
        (globalThis as any).__serviceeventsMonitorException(ctx, new TypeError('kaboom'));
        (globalThis as any).__serviceeventsMonitorExit(ctx);
        expect(state.peekInvestigationData()?.exception?.functionName).toBe('boomHandler');
        expect(state.peekInvestigationData()?.exception?.name).toBe('TypeError');
      } finally {
        monitor.unregisterMonitorGlobals();
      }
    });
  });

  describe('exceptionFromSpanEvent', () => {
    const excEvent = (type?: string, message?: string, stacktrace?: string) => {
      const attributes: Attributes = {};
      if (type !== undefined) attributes[ATTR_EXCEPTION_TYPE] = type;
      if (message !== undefined) attributes[ATTR_EXCEPTION_MESSAGE] = message;
      if (stacktrace !== undefined) attributes[ATTR_EXCEPTION_STACKTRACE] = stacktrace;
      return { name: 'exception', attributes };
    };

    it('returns undefined when the span has no events', () => {
      expect(exceptionFromSpanEvent(buildSpan({ events: [] }))).toBeUndefined();
    });

    it('returns undefined when there is no exception event', () => {
      expect(exceptionFromSpanEvent(buildSpan({ events: [{ name: 'some.other.event' }] }))).toBeUndefined();
    });

    it('parses an exception event into name/message/traceback', () => {
      const result = exceptionFromSpanEvent(
        buildSpan({ events: [excEvent('ValueError', 'bad input', 'Traceback...')] })
      );
      expect(result).toEqual({
        name: 'ValueError',
        message: 'bad input',
        traceback: 'Traceback...',
        functionName: 'unknown',
      });
    });

    it('takes the first exception event when several are recorded', () => {
      const result = exceptionFromSpanEvent(buildSpan({ events: [excEvent('FirstError'), excEvent('LastError')] }));
      expect(result?.name).toBe('FirstError');
    });

    it('skips an exception event missing exception.type', () => {
      expect(exceptionFromSpanEvent(buildSpan({ events: [excEvent(undefined, 'no type')] }))).toBeUndefined();
    });

    it('defaults message and traceback to empty strings when absent', () => {
      const result = exceptionFromSpanEvent(buildSpan({ events: [excEvent('KeyError')] }));
      expect(result).toEqual({ name: 'KeyError', message: '', traceback: '', functionName: 'unknown' });
    });

    it('extracts function name from a V8 stack trace', () => {
      const stack =
        'Error: gateway down\n    at processOrder (/app/checkout.js:42:10)\n    at handler (/app/server.js:5:3)';
      const result = exceptionFromSpanEvent(buildSpan({ events: [excEvent('Error', 'gateway down', stack)] }));
      expect(result?.functionName).toBe('processOrder');
    });

    it('returns unknown when stack trace has no parseable frames', () => {
      const result = exceptionFromSpanEvent(buildSpan({ events: [excEvent('Error', 'oops', 'no frames here')] }));
      expect(result?.functionName).toBe('unknown');
    });
  });

  describe('extractFunctionFromStackTrace', () => {
    it('extracts function from standard V8 stack', () => {
      const stack = 'Error: boom\n    at myFunction (/app/file.js:10:5)\n    at caller (/app/main.js:3:1)';
      expect(extractFunctionFromStackTrace(stack)).toBe('myFunction');
    });

    it('extracts Object.method format', () => {
      const stack = 'TypeError: x\n    at Object.processPayment (/app/pay.js:7:3)';
      expect(extractFunctionFromStackTrace(stack)).toBe('Object.processPayment');
    });

    it('returns unknown for undefined', () => {
      expect(extractFunctionFromStackTrace(undefined)).toBe('unknown');
    });

    it('returns unknown for empty string', () => {
      expect(extractFunctionFromStackTrace('')).toBe('unknown');
    });

    it('returns unknown when no at-frames present', () => {
      expect(extractFunctionFromStackTrace('just a message')).toBe('unknown');
    });
  });

  describe('span-event fault recovery (onEnd seeds investigation data)', () => {
    const excEvent = (type: string, message: string) => ({
      name: 'exception',
      attributes: { [ATTR_EXCEPTION_TYPE]: type, [ATTR_EXCEPTION_MESSAGE]: message },
    });

    it('seeds the span exception into investigation data for a 5xx with no AST capture', () => {
      // The 5xx unwound through uninstrumented code: the AST monitor captured nothing, but OTel
      // recorded an exception event on the span. onEnd must seed it so the breakdown/snapshot
      // recover the fault — otherwise exception attribution is silently lost.
      monitor.registerMonitorGlobals();
      try {
        const state = monitor.ServiceEventsMonitorState.getInstance();
        state.beginInvestigation(true); // fresh store, no exception (as onStart would leave it)
        const processor = new ServiceEventsSpanProcessor(null, null, null);
        const span = buildSpan({
          name: 'GET /boom',
          attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500 },
          events: [excEvent('RuntimeError', 'boom')],
        });
        // onEnd clears the store in its finally, so capture the exception via the error extractor
        // which peeks the seeded data before the clear.
        const seen: Array<string | undefined> = [];
        const stub = sinon.stub(errorExtraction, 'extractErrorFromCallPath').callsFake(() => {
          seen.push(state.peekInvestigationData()?.exception?.name);
          return undefined;
        });
        try {
          processor.onEnd(span);
        } finally {
          stub.restore();
        }
        expect(seen).toEqual(['RuntimeError']);
      } finally {
        monitor.unregisterMonitorGlobals();
      }
    });

    it('does not overwrite an AST-captured exception (first-writer-wins)', () => {
      monitor.registerMonitorGlobals();
      try {
        const state = monitor.ServiceEventsMonitorState.getInstance();
        state.beginInvestigation(true);
        // A real instrumented throw recorded its origin function.
        const ctx = (globalThis as any).__serviceeventsMonitorEnter('realHandler');
        (globalThis as any).__serviceeventsMonitorException(ctx, new TypeError('real'));
        (globalThis as any).__serviceeventsMonitorExit(ctx);

        const processor = new ServiceEventsSpanProcessor(null, null, null);
        const span = buildSpan({
          name: 'GET /boom',
          attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500 },
          events: [excEvent('RuntimeError', 'from span')],
        });
        const captured: Array<{ name?: string; functionName?: string }> = [];
        const stub = sinon.stub(errorExtraction, 'extractErrorFromCallPath').callsFake(() => {
          const exc = state.peekInvestigationData()?.exception;
          captured.push({ name: exc?.name, functionName: exc?.functionName });
          return undefined;
        });
        try {
          processor.onEnd(span);
        } finally {
          stub.restore();
        }
        // The instrumented capture (with its true origin) wins over the span event.
        expect(captured).toEqual([{ name: 'TypeError', functionName: 'realHandler' }]);
      } finally {
        monitor.unregisterMonitorGlobals();
      }
    });

    it('does not seed for a 2xx even when an exception event is present', () => {
      monitor.registerMonitorGlobals();
      try {
        const state = monitor.ServiceEventsMonitorState.getInstance();
        state.beginInvestigation(true);
        const processor = new ServiceEventsSpanProcessor(null, null, null);
        const span = buildSpan({
          name: 'GET /ok',
          attributes: { [ATTR_HTTP_REQUEST_METHOD]: 'GET', [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 },
          events: [excEvent('RuntimeError', 'boom')],
        });
        const seen: Array<unknown> = [];
        const stub = sinon.stub(errorExtraction, 'extractErrorFromCallPath').callsFake(() => {
          seen.push(state.peekInvestigationData()?.exception ?? null);
          return undefined;
        });
        try {
          processor.onEnd(span);
        } finally {
          stub.restore();
        }
        // extractErrorFromCallPath only runs for >= 400; a 2xx never reaches it, so `seen` is empty
        // and nothing was seeded.
        expect(seen).toEqual([]);
      } finally {
        monitor.unregisterMonitorGlobals();
      }
    });
  });

  describe('lifecycle', () => {
    it('forceFlush and shutdown resolve', async () => {
      const processor = new ServiceEventsSpanProcessor(null, null, null);
      await expect(processor.forceFlush()).resolves.toBeUndefined();
      await expect(processor.shutdown()).resolves.toBeUndefined();
    });
  });
});
