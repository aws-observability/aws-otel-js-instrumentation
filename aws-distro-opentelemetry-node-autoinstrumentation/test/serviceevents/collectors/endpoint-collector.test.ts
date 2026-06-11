// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { EndpointMetricCollector } from '../../../src/serviceevents/collectors/endpoint-collector';
import { ServiceEventsOtlpEmitter } from '../../../src/serviceevents/exporter/otlp-emitter';
import { EndpointMetricEvent, EndpointErrorMetric } from '../../../src/serviceevents/models/endpoint-telemetry';

class CaptureEmitter extends ServiceEventsOtlpEmitter {
  endpointSummaries: EndpointMetricEvent[] = [];
  errorMetrics: EndpointErrorMetric[] = [];
  constructor() {
    super({ serviceName: 'svc', environment: 'env' });
  }
  override emitEndpointSummary(evt: EndpointMetricEvent): void {
    this.endpointSummaries.push(evt);
  }
  override emitEndpointErrorMetric(metric: EndpointErrorMetric): void {
    this.errorMetrics.push(metric);
  }
}

describe('EndpointMetricCollector (OTLP)', function () {
  let collector: EndpointMetricCollector;
  let emitter: CaptureEmitter;

  beforeEach(function () {
    emitter = new CaptureEmitter();
    collector = new EndpointMetricCollector(600_000, 'env', 'svc', '0.0.1', emitter, null);
  });

  afterEach(function () {
    try {
      collector.stop();
    } catch {
      // Ignore
    }
  });

  it('emits EndpointSummary on collect', function () {
    collector.recordRequest('/api/users', 'GET', 200, 10_000_000);
    collector.recordRequest('/api/users', 'GET', 200, 20_000_000);
    collector.collect();
    expect(emitter.endpointSummaries.length).toBe(1);
    expect(emitter.endpointSummaries[0].count).toBe(2);
    expect(emitter.endpointSummaries[0].operation).toBe('GET /api/users');
  });

  it('tracks different endpoints separately', function () {
    collector.recordRequest('/api/users', 'GET', 200, 10_000_000);
    collector.recordRequest('/api/orders', 'POST', 201, 20_000_000);
    collector.collect();
    expect(emitter.endpointSummaries.length).toBe(2);
  });

  it('error_breakdown entries use function_name', function () {
    collector.recordRequest('/api/users', 'GET', 500, 10_000_000, {
      errorType: 'TypeError',
      functionName: 'app.handler',
    });
    collector.collect();
    const evt = emitter.endpointSummaries[0];
    expect(evt.error_breakdown[0].failure_type).toBe('500');
    expect(evt.error_breakdown[0].errors[0].error_type).toBe('TypeError');
    expect(evt.error_breakdown[0].errors[0].function_name).toBe('app.handler');
  });

  it('tracks faults (5xx) and errors (4xx)', function () {
    collector.recordRequest('/api/u', 'GET', 500, 10_000_000);
    collector.recordRequest('/api/u', 'GET', 503, 10_000_000);
    collector.recordRequest('/api/u', 'GET', 404, 10_000_000);
    collector.recordRequest('/api/u', 'GET', 200, 10_000_000);
    collector.collect();
    const evt = emitter.endpointSummaries[0];
    expect(evt.count).toBe(4);
    expect(evt.faults).toBe(2);
    expect(evt.errors).toBe(1);
  });

  it('emits EndpointErrorMetric per error type', function () {
    collector.recordRequest('/api/u', 'GET', 500, 10_000_000, {
      errorType: 'TypeError',
      functionName: 'app.a',
    });
    collector.recordRequest('/api/u', 'GET', 500, 10_000_000, {
      errorType: 'TypeError',
      functionName: 'app.a',
    });
    collector.recordRequest('/api/u', 'GET', 500, 10_000_000, {
      errorType: 'RuntimeError',
      functionName: 'app.b',
    });
    collector.collect();
    expect(emitter.errorMetrics.length).toBe(2);
    const byType = new Map(emitter.errorMetrics.map(m => [m.exception, m.count]));
    expect(byType.get('TypeError')).toBe(2);
    expect(byType.get('RuntimeError')).toBe(1);
  });

  it('lookupOperation returns the operation string when the operation was observed', function () {
    collector.recordRequest('/api/x', 'POST', 200, 10_000_000);
    expect(collector.lookupOperation('POST /api/x')).toBe('POST /api/x');
    expect(collector.lookupOperation('GET /never-seen')).toBeNull();
    expect(collector.lookupOperation(null)).toBeNull();
  });

  it('emits at most 5 error breakdown entries per endpoint, sorted by count desc (Java parity)', function () {
    // Record 8 distinct error types — only the top 5 by count should be emitted.
    for (let i = 0; i < 8; i++) {
      const hits = 8 - i; // error0 has 8 hits, error7 has 1 hit
      for (let j = 0; j < hits; j++) {
        collector.recordRequest('/api/x', 'GET', 500, 1_000_000, {
          errorType: `Error${i}`,
          functionName: `app.fn${i}`,
        });
      }
    }
    collector.collect();
    const summary = emitter.endpointSummaries.find(s => s.operation === 'GET /api/x');
    expect(summary).toBeDefined();
    const breakdown = summary!.error_breakdown;
    expect(breakdown.length).toBeLessThanOrEqual(5);
    // Top entry must have the highest count (Error0 has 8 hits).
    expect(breakdown[0].errors[0].error_type).toBe('Error0');
    expect(breakdown[0].count).toBe(8);
    // Entries must be sorted descending by count.
    for (let i = 1; i < breakdown.length; i++) {
      expect(breakdown[i].count).toBeLessThanOrEqual(breakdown[i - 1].count);
    }
  });
});

describe('EndpointMetricCollector (Application Signals suppression)', function () {
  let emitter: CaptureEmitter;

  beforeEach(function () {
    emitter = new CaptureEmitter();
  });

  it('suppresses EndpointSummary but still emits error metrics when flag is true', function () {
    const collector = new EndpointMetricCollector(600_000, 'env', 'svc', '0.0.1', emitter, null, true);
    try {
      collector.recordRequest('/api/u', 'GET', 500, 10_000_000, {
        errorType: 'TypeError',
        functionName: 'app.a',
      });
      collector.recordRequest('/api/u', 'GET', 200, 10_000_000);
      collector.collect();
    } finally {
      try {
        collector.stop();
      } catch {
        // ignore
      }
    }
    expect(emitter.endpointSummaries.length).toBe(0);
    expect(emitter.errorMetrics.length).toBe(1);
    expect(emitter.errorMetrics[0].exception).toBe('TypeError');
  });

  it('emits EndpointSummary when flag is false (default)', function () {
    const collector = new EndpointMetricCollector(600_000, 'env', 'svc', '0.0.1', emitter, null, false);
    try {
      collector.recordRequest('/api/u', 'GET', 200, 10_000_000);
      collector.collect();
    } finally {
      try {
        collector.stop();
      } catch {
        // ignore
      }
    }
    expect(emitter.endpointSummaries.length).toBe(1);
  });

  it('clears aggregations on collect even when suppressing', function () {
    const collector = new EndpointMetricCollector(600_000, 'env', 'svc', '0.0.1', emitter, null, true);
    try {
      collector.recordRequest('/api/u', 'GET', 200, 10_000_000);
      collector.collect();
      // Second collect with no new data: should be a no-op (aggregations drained).
      collector.collect();
    } finally {
      try {
        collector.stop();
      } catch {
        // ignore
      }
    }
    // Both emit calls should have seen empty aggregations the second time around,
    // so no additional summaries were emitted (suppressed on call 1, nothing on call 2).
    expect(emitter.endpointSummaries.length).toBe(0);
  });
});
