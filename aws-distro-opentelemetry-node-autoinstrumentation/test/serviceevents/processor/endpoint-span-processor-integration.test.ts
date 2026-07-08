// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end integration tests for the framework-agnostic endpoint span processor.
 *
 * Unlike endpoint-span-processor.test.ts — which feeds hand-built ReadableSpans and stubs the
 * monitor/collector — these register the REAL processor on a REAL OTel SDK BasicTracerProvider and
 * emit REAL spans (`tracer.startSpan(...).end()` → the SDK fires onStart/onEnd → getIngressOperation
 * → route back-out → the real EndpointMetricCollector). This exercises the now-DEFAULT span-processor
 * path the way framework instrumentation actually produces it, including the real monitor state and
 * the span `exception` event fault recovery, so the architectural assumptions (onStart/onEnd fire on
 * the same span, operation parity, exception seeding) are validated rather than mocked away.
 */

import { ROOT_CONTEXT, SpanKind, context } from '@opentelemetry/api';
import { AlwaysOnSampler, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
} from '@opentelemetry/semantic-conventions';
import expect from 'expect';
import { EndpointMetricCollector } from '../../../src/serviceevents/collectors/endpoint-collector';
import { EndpointMetricEvent } from '../../../src/serviceevents/models/endpoint-telemetry';
import { ServiceEventsConfig } from '../../../src/serviceevents/config';
import { ServiceEventsSpanProcessor } from '../../../src/serviceevents/processor/endpoint-span-processor';
import * as monitor from '../../../src/serviceevents/serviceevents-monitor';

const ATTR_HTTP_ROUTE = 'http.route';
const ATTR_URL_PATH = 'url.path';

describe('ServiceEventsSpanProcessor (integration: real provider + real span)', function () {
  let savedLambdaFn: string | undefined;
  let emitted: EndpointMetricEvent[];
  let collector: EndpointMetricCollector;
  let provider: BasicTracerProvider;
  let tracer: ReturnType<BasicTracerProvider['getTracer']>;

  beforeEach(function () {
    // getIngressOperation forces "<fn>/FunctionHandler" when AWS_LAMBDA_FUNCTION_NAME is set;
    // other suites leak it, so neutralize for these tests and restore after.
    savedLambdaFn = process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;

    emitted = [];
    const fakeEmitter: any = {
      emitEndpointSummary: (event: EndpointMetricEvent) => emitted.push(event),
      emitEndpointErrorMetric: () => {},
    };
    collector = new EndpointMetricCollector(3_600_000, undefined, 'svc', '0.0.0', fakeEmitter);
    const config = { endpointIncludePatterns: [], endpointExcludePatterns: [] } as unknown as ServiceEventsConfig;
    const processor = new ServiceEventsSpanProcessor(collector, null, config);

    // SDK 2.x registers processors via the provider constructor. Pin AlwaysOnSampler so leaked
    // sampler env/state from other suites can't yield non-recording spans (which skip onStart/onEnd).
    provider = new BasicTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [processor] } as any);
    tracer = provider.getTracer('integration-test');

    monitor.registerMonitorGlobals();
    monitor.ServiceEventsMonitorState.getInstance().getInvestigationData(); // clear any leak
  });

  afterEach(function () {
    monitor.unregisterMonitorGlobals();
    if (savedLambdaFn === undefined) {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    } else {
      process.env.AWS_LAMBDA_FUNCTION_NAME = savedLambdaFn;
    }
  });

  /**
   * Emit a real SERVER span exactly as framework instrumentation would, then flush the collector.
   *
   * Emission is wrapped in a fresh ROOT_CONTEXT. This is the faithful model — a real inbound
   * request boundary span is created in a clean request context — and it makes the test hermetic
   * against an upstream leak: AwsXraySamplingClient issues its HTTP calls inside
   * `context.with(suppressTracing(...))` and its nock-stubbed callbacks resolve inside that
   * suppressed frame, leaving the global ALS root store tracing-suppressed for the rest of the run.
   * OTel's `Tracer.startSpan` short-circuits to a NonRecordingSpan whenever the active context is
   * suppressed (before the sampler is even consulted), which would skip onStart/onEnd entirely.
   */
  function emitRequestSpan(
    name: string,
    attributes: Record<string, unknown>,
    events?: Array<{ name: string; attributes: Record<string, unknown> }>
  ): EndpointMetricEvent[] {
    context.with(ROOT_CONTEXT, () => {
      const span = tracer.startSpan(name, { kind: SpanKind.SERVER, attributes: attributes as any });
      for (const e of events ?? []) {
        span.addEvent(e.name, e.attributes as any);
      }
      span.end();
    });
    collector.collect();
    return emitted;
  }

  it('records a matched-route 2xx end to end', function () {
    const events = emitRequestSpan('GET /users/:id', {
      [ATTR_HTTP_REQUEST_METHOD]: 'GET',
      [ATTR_HTTP_ROUTE]: '/users/:id',
      [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200,
    });
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('GET /users/:id');
    expect(events[0].route).toBe('/users/:id');
    expect(events[0].count).toBe(1);
    expect(events[0].faults).toBe(0);
    expect(events[0].errors).toBe(0);
  });

  it('collapses an unmatched route to its first path segment end to end', function () {
    const events = emitRequestSpan('GET', {
      [ATTR_HTTP_REQUEST_METHOD]: 'GET',
      [ATTR_URL_PATH]: '/wp-admin/setup.php',
      [ATTR_HTTP_RESPONSE_STATUS_CODE]: 404,
    });
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('GET /wp-admin');
    expect(events[0].errors).toBe(1); // 4xx is an error, not a fault
  });

  it('recovers a 5xx fault from the span exception event end to end', function () {
    // The defining case: a 5xx whose exception was never seen by an AST-instrumented frame
    // (library code / global handler) still appears in the error breakdown because the processor
    // recovers it from the span's own OTel `exception` event and seeds the investigation data.
    const events = emitRequestSpan(
      'POST /checkout',
      {
        [ATTR_HTTP_REQUEST_METHOD]: 'POST',
        [ATTR_HTTP_ROUTE]: '/checkout',
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500,
      },
      [
        {
          name: 'exception',
          attributes: {
            [ATTR_EXCEPTION_TYPE]: 'RangeError',
            [ATTR_EXCEPTION_MESSAGE]: 'gateway down',
            [ATTR_EXCEPTION_STACKTRACE]: 'Error: gateway down\n    at handler',
          },
        },
      ]
    );
    expect(events).toHaveLength(1);
    expect(events[0].faults).toBe(1);
    const breakdown = events[0].error_breakdown;
    expect(breakdown.length).toBeGreaterThan(0);
    const entry = breakdown.find(b => b.errors.some(e => e.error_type === 'RangeError'));
    expect(entry).toBeDefined();
  });

  it('does not record an INTERNAL child span as its own endpoint', function () {
    context.with(ROOT_CONTEXT, () => {
      const parent = tracer.startSpan('GET /parent', {
        kind: SpanKind.SERVER,
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: 'GET',
          [ATTR_HTTP_ROUTE]: '/parent',
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200,
        },
      });
      const child = tracer.startSpan('db.query', { kind: SpanKind.INTERNAL });
      child.end();
      parent.end();
    });
    collector.collect();
    // Exactly one endpoint (the SERVER span); the INTERNAL child is excluded.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].operation).toBe('GET /parent');
  });

  it('aggregates multiple requests onto the same operation', function () {
    for (let i = 0; i < 3; i++) {
      context.with(ROOT_CONTEXT, () => {
        tracer
          .startSpan('GET /health', {
            kind: SpanKind.SERVER,
            attributes: {
              [ATTR_HTTP_REQUEST_METHOD]: 'GET',
              [ATTR_HTTP_ROUTE]: '/health',
              [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200,
            },
          })
          .end();
      });
    }
    collector.collect();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].operation).toBe('GET /health');
    expect(emitted[0].count).toBe(3);
  });
});
