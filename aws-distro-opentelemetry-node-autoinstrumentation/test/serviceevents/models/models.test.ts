// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  FunctionCallMetrics,
  DurationMetrics,
  MetricsStatsEntry,
} from '../../../src/serviceevents/models/function-telemetry';
import {
  EndpointMetricEvent,
  ErrorBreakdownEntry,
  IncidentExemplar,
} from '../../../src/serviceevents/models/endpoint-telemetry';
import {
  IncidentSnapshot,
  RequestContext,
  TelemetryCorrelation,
} from '../../../src/serviceevents/models/incident-telemetry';
import { ResourceAttributes } from '../../../src/serviceevents/models/resource-attributes';

describe('ResourceAttributes', function () {
  it('should create empty instance', function () {
    const ra = new ResourceAttributes();
    expect(ra.isEmpty()).toBe(true);
    expect(ra.toDict()).toEqual({});
  });

  it('should create with fields', function () {
    const ra = new ResourceAttributes({
      cloud_provider: 'aws',
      cloud_region: 'us-east-1',
      host_id: 'i-1234567890',
    });
    expect(ra.isEmpty()).toBe(false);
    expect(ra.cloud_provider).toBe('aws');
    expect(ra.cloud_region).toBe('us-east-1');
    expect(ra.host_id).toBe('i-1234567890');
  });

  it('toDict() should use OTel dot-notation keys', function () {
    const ra = new ResourceAttributes({
      cloud_provider: 'aws',
      cloud_region: 'us-east-1',
      host_id: 'i-1234567890',
    });
    const dict = ra.toDict();
    expect(dict['cloud.provider']).toBe('aws');
    expect(dict['cloud.region']).toBe('us-east-1');
    expect(dict['host.id']).toBe('i-1234567890');
    // Should not include undefined fields
    expect(Object.keys(dict).length).toBe(3);
  });

  it('fromOtelResource() should map OTel keys to fields', function () {
    const resource = {
      attributes: {
        'cloud.provider': 'aws',
        'cloud.platform': 'aws_ec2',
        'cloud.region': 'us-west-2',
        'host.id': 'i-abc123',
        'k8s.cluster.name': 'my-cluster',
      },
    };
    const ra = ResourceAttributes.fromOtelResource(resource);
    expect(ra.cloud_provider).toBe('aws');
    expect(ra.cloud_platform).toBe('aws_ec2');
    expect(ra.cloud_region).toBe('us-west-2');
    expect(ra.host_id).toBe('i-abc123');
    expect(ra.k8s_cluster_name).toBe('my-cluster');
    expect(ra.isEmpty()).toBe(false);
  });

  it('fromOtelResource() should handle null resource', function () {
    const ra = ResourceAttributes.fromOtelResource(null);
    expect(ra.isEmpty()).toBe(true);
  });
});

describe('FunctionCallMetrics', function () {
  it('should create with required fields', function () {
    const metrics = new FunctionCallMetrics({
      environment: 'production',
      service_name: 'test-service',
      sdk_version: '0.14.2',
      instance_id: 'host-1',
      function_name: 'func-123',
      pid: 12345,
      timestamp: '2026-02-01T00:00:00Z',
    });

    expect(metrics.environment).toBe('production');
    expect(metrics.service_name).toBe('test-service');
    expect(metrics.function_name).toBe('func-123');
    expect(metrics.version).toBe('1');
    expect(metrics.telemetry_type).toBe('FunctionCall');
    expect(metrics.operation).toBe(null);
    expect(metrics.caller).toBe(null);
    expect(metrics.is_async).toBe(false);
    expect(metrics.exceptions).toEqual({});
    expect(metrics.MetricsStats).toBe(null);
    expect(metrics.resource_attributes).toBe(null);
  });

  it('should create with all optional fields', function () {
    const duration: DurationMetrics = {
      values: [100, 200],
      counts: [5, 3],
      max: 200,
      min: 100,
      count: 8,
      sum: 1100,
    };

    const metricsStats: MetricsStatsEntry[] = [
      {
        Dimensions: [['env']],
        Metrics: [{ Name: 'duration', Unit: 'Microseconds' }],
      },
    ];

    const ra = new ResourceAttributes({ cloud_region: 'us-east-1' });

    const metrics = new FunctionCallMetrics({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      function_name: 'f1',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
      operation: 'POST /users',
      caller: 'caller-func',
      is_async: true,
      exceptions: { TypeError: 3 },
      duration,
      MetricsStats: metricsStats,
      resource_attributes: ra,
    });

    expect(metrics.operation).toBe('POST /users');
    expect(metrics.caller).toBe('caller-func');
    expect(metrics.is_async).toBe(true);
    expect(metrics.exceptions.TypeError).toBe(3);
    expect(metrics.duration).toBe(duration);
    expect(metrics.MetricsStats).toBe(metricsStats);
    expect(metrics.resource_attributes).toBe(ra);
  });

  it('toDict() should return all fields', function () {
    const metrics = new FunctionCallMetrics({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      function_name: 'f1',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
    });

    const dict = metrics.toDict();
    expect(dict.telemetry_type).toBe('FunctionCall');
    expect(dict.version).toBe('1');
    expect(dict.environment).toBe('dev');
    expect(dict.function_name).toBe('f1');
    expect(dict.is_async).toBe(false);
    expect(dict.MetricsStats).toBe(null);
  });

  it('toDict() should include resource_attributes when non-empty', function () {
    const ra = new ResourceAttributes({ cloud_region: 'us-east-1' });
    const metrics = new FunctionCallMetrics({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      function_name: 'f1',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
      resource_attributes: ra,
    });

    const dict = metrics.toDict();
    expect(dict.resource_attributes).toEqual({ 'cloud.region': 'us-east-1' });
  });

  it('toDict() should not include resource_attributes when empty', function () {
    const ra = new ResourceAttributes();
    const metrics = new FunctionCallMetrics({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      function_name: 'f1',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
      resource_attributes: ra,
    });

    const dict = metrics.toDict();
    expect(dict.resource_attributes).toBeUndefined();
  });

  it('toEmfDict() should capitalize duration keys', function () {
    const duration: DurationMetrics = {
      values: [100],
      counts: [1],
      max: 100,
      min: 100,
      count: 1,
      sum: 100,
    };

    const metrics = new FunctionCallMetrics({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      function_name: 'f1',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
      duration,
    });

    const emf = metrics.toEmfDict();
    const emfDuration = emf.duration as Record<string, unknown>;
    expect(emfDuration.Values).toEqual([100]);
    expect(emfDuration.Counts).toEqual([1]);
    expect(emfDuration.Max).toBe(100);
    expect(emfDuration.Min).toBe(100);
    expect(emfDuration.Count).toBe(1);
    expect(emfDuration.Sum).toBe(100);
  });

  it('toEmfDict() should handle null duration', function () {
    const metrics = new FunctionCallMetrics({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      function_name: 'f1',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
    });

    const emf = metrics.toEmfDict();
    expect(emf.duration).toBe(null);
  });

  it('should be JSON serializable', function () {
    const metrics = new FunctionCallMetrics({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      function_name: 'f1',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
    });

    const json = JSON.stringify(metrics.toDict());
    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.function_name).toBe('f1');
  });
});

describe('EndpointMetricEvent', function () {
  it('should create with required fields', function () {
    const event = new EndpointMetricEvent({
      environment: 'production',
      service_name: 'test-service',
      sdk_version: '0.14.2',
      instance_id: 'host-1',
      method: 'GET',
      route: '/api/users',
      operation: 'GET /api/users',
      pid: 12345,
      timestamp: '2026-02-01T00:00:00Z',
      count: 100,
    });

    expect(event.telemetry_type).toBe('EndpointSummary');
    expect(event.method).toBe('GET');
    expect(event.route).toBe('/api/users');
    expect(event.count).toBe(100);
    expect(event.faults).toBe(0);
    expect(event.errors).toBe(0);
    expect(event.incident_count).toBe(0);
    expect(event.incidents_exemplar).toEqual([]);
    expect(event.duration).toBe(null);
    expect(event.MetricsStats).toBe(null);
    expect(event.resource_attributes).toBe(null);
    expect(event.error_breakdown).toEqual([]);
  });

  it('should include new fields', function () {
    const exemplar: IncidentExemplar = {
      snapshot_id: 'snap_123',
      trigger_type: 'exception',
      severity: 'critical',
      timestamp: 1706745600000,
    };

    const duration: DurationMetrics = {
      values: [100],
      counts: [1],
      max: 100,
      min: 100,
      count: 1,
      sum: 100,
    };

    const ra = new ResourceAttributes({ cloud_region: 'us-east-1' });

    const event = new EndpointMetricEvent({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      method: 'POST',
      route: '/api/orders',
      operation: 'POST /api/orders',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
      count: 10,
      faults: 3,
      errors: 2,
      incident_count: 1,
      incidents_exemplar: [exemplar],
      duration,
      resource_attributes: ra,
    });

    expect(event.faults).toBe(3);
    expect(event.errors).toBe(2);
    expect(event.incident_count).toBe(1);
    expect(event.incidents_exemplar).toHaveLength(1);
    expect(event.duration).toBe(duration);
    expect(event.resource_attributes).toBe(ra);
  });

  it('should include error breakdown', function () {
    const errors: ErrorBreakdownEntry[] = [
      {
        errors: [{ error_type: 'TypeError', function_name: 'f1' }],
        count: 5,
        failure_type: '500',
      },
    ];

    const event = new EndpointMetricEvent({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      method: 'POST',
      route: '/api/orders',
      operation: 'POST /api/orders',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
      count: 10,
      error_breakdown: errors,
    });

    expect(event.error_breakdown).toHaveLength(1);
    expect(event.error_breakdown[0].failure_type).toBe('500');
    expect(event.error_breakdown[0].count).toBe(5);
  });

  it('toDict() should omit zero/empty fields (sparse)', function () {
    const event = new EndpointMetricEvent({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      method: 'GET',
      route: '/test',
      operation: 'GET /test',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
      count: 50,
    });

    const dict = event.toDict();
    expect(dict.telemetry_type).toBe('EndpointSummary');
    expect(dict.operation).toBe('GET /test');
    expect(dict.count).toBe(50);
    // Zero/empty fields should be omitted
    expect(dict.faults).toBeUndefined();
    expect(dict.errors).toBeUndefined();
    expect(dict.incident_count).toBeUndefined();
    expect(dict.incidents_exemplar).toBeUndefined();
    expect(dict.duration).toBeUndefined();
    expect(dict.MetricsStats).toBeUndefined();
    expect(dict.resource_attributes).toBeUndefined();
  });

  it('toDict() should include non-zero fields', function () {
    const ra = new ResourceAttributes({ cloud_region: 'us-east-1' });
    const event = new EndpointMetricEvent({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      method: 'GET',
      route: '/test',
      operation: 'GET /test',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
      count: 50,
      faults: 5,
      errors: 3,
      resource_attributes: ra,
    });

    const dict = event.toDict();
    expect(dict.faults).toBe(5);
    expect(dict.errors).toBe(3);
    expect(dict.resource_attributes).toEqual({ 'cloud.region': 'us-east-1' });
  });

  it('toEmfDict() should capitalize duration keys', function () {
    const duration: DurationMetrics = {
      values: [100],
      counts: [1],
      max: 100,
      min: 100,
      count: 1,
      sum: 100,
    };

    const event = new EndpointMetricEvent({
      environment: 'dev',
      service_name: 'svc',
      sdk_version: '1.0',
      instance_id: 'host',
      method: 'GET',
      route: '/test',
      operation: 'GET /test',
      pid: 1,
      timestamp: '2026-01-01T00:00:00Z',
      count: 50,
      duration,
    });

    const emf = event.toEmfDict();
    const emfDuration = emf.duration as Record<string, unknown>;
    expect(emfDuration.Values).toEqual([100]);
    expect(emfDuration.Max).toBe(100);
  });
});

describe('IncidentSnapshot', function () {
  function createMinimalSnapshot(): IncidentSnapshot {
    return new IncidentSnapshot({
      snapshot_id: 'snap_1',
      timestamp: 1706745600000,
      severity: 'low',
      trigger_type: 'latency',
      service: 'svc',
      environment: 'dev',
      instance_id: 'host',
      affected_endpoint: '/test',
      sdk_version: '0.14.2',
      pid: 1,
      duration_ms: 100,
      exception_info: [],
      request_context: {
        type: 'http',
        timestamp: 1706745600000,
        status_code: 200,
        custom_context: {},
      },
      telemetry_correlation: {
        correlation_ids: {},
      },
    });
  }

  it('should create with required fields', function () {
    const snapshot = createMinimalSnapshot();
    expect(snapshot.telemetry_type).toBe('IncidentSnapshot');
    expect(snapshot.severity).toBe('low');
    expect(snapshot.trigger_type).toBe('latency');
    expect(snapshot.is_partial).toBe(false);
    expect(snapshot.resource_attributes).toBe(null);
  });

  it('should support is_partial field', function () {
    const snapshot = new IncidentSnapshot({
      snapshot_id: 'snap_1',
      timestamp: 1706745600000,
      severity: 'low',
      trigger_type: 'latency',
      service: 'svc',
      environment: 'dev',
      instance_id: 'host',
      affected_endpoint: '/test',
      sdk_version: '0.14.2',
      pid: 1,
      duration_ms: 100,
      is_partial: true,
      exception_info: [],
      request_context: {
        type: 'http',
        timestamp: 1706745600000,
        status_code: 200,
        custom_context: {},
      },
      telemetry_correlation: {
        correlation_ids: {},
      },
    });

    expect(snapshot.is_partial).toBe(true);
    const dict = snapshot.toDict();
    expect(dict.is_partial).toBe(true);
  });

  it('should support resource_attributes', function () {
    const ra = new ResourceAttributes({ cloud_region: 'us-east-1' });
    const snapshot = new IncidentSnapshot({
      snapshot_id: 'snap_1',
      timestamp: 1706745600000,
      severity: 'low',
      trigger_type: 'latency',
      service: 'svc',
      environment: 'dev',
      instance_id: 'host',
      affected_endpoint: '/test',
      sdk_version: '0.14.2',
      pid: 1,
      duration_ms: 100,
      exception_info: [],
      request_context: {
        type: 'http',
        timestamp: 1706745600000,
        status_code: 200,
        custom_context: {},
      },
      telemetry_correlation: {
        correlation_ids: {},
      },
      resource_attributes: ra,
    });

    const dict = snapshot.toDict();
    expect(dict.resource_attributes).toEqual({ 'cloud.region': 'us-east-1' });
  });

  it('should omit is_async when false in call_path', function () {
    const snapshot = new IncidentSnapshot({
      snapshot_id: 'snap_1',
      timestamp: 1706745600000,
      severity: 'critical',
      trigger_type: 'exception',
      service: 'svc',
      environment: 'dev',
      instance_id: 'host',
      affected_endpoint: '/test',
      sdk_version: '0.14.2',
      pid: 1,
      duration_ms: 100,
      exception_info: [
        {
          exception_type: 'Error',
          exception_message: 'test',
          stack_trace: 'Error: test',
          call_path: [{ function_name: 'f1', caller_function_name: '', duration_ns: 1000, error: false }],
        },
      ],
      request_context: {
        type: 'http',
        timestamp: 1706745600000,
        status_code: 500,
        custom_context: {},
      },
      telemetry_correlation: { correlation_ids: {} },
    });

    const dict = snapshot.toDict();
    const callPath = (dict.exception_info as any[])[0].call_path;
    expect(callPath[0].is_async).toBeUndefined();
    expect(callPath[0].duration_ns).toBe(1000);
  });

  it('should include is_async when true in call_path', function () {
    const snapshot = new IncidentSnapshot({
      snapshot_id: 'snap_1',
      timestamp: 1706745600000,
      severity: 'critical',
      trigger_type: 'exception',
      service: 'svc',
      environment: 'dev',
      instance_id: 'host',
      affected_endpoint: '/test',
      sdk_version: '0.14.2',
      pid: 1,
      duration_ms: 100,
      exception_info: [
        {
          exception_type: 'Error',
          exception_message: 'test',
          stack_trace: 'Error: test',
          call_path: [
            { function_name: 'f1', caller_function_name: '', duration_ns: 1000, error: false, is_async: true },
          ],
        },
      ],
      request_context: {
        type: 'http',
        timestamp: 1706745600000,
        status_code: 500,
        custom_context: {},
      },
      telemetry_correlation: { correlation_ids: {} },
    });

    const dict = snapshot.toDict();
    const callPath = (dict.exception_info as any[])[0].call_path;
    expect(callPath[0].is_async).toBe(true);
  });

  it('should strip duration_ns from call_path when is_partial', function () {
    const snapshot = new IncidentSnapshot({
      snapshot_id: 'snap_1',
      timestamp: 1706745600000,
      severity: 'critical',
      trigger_type: 'exception',
      service: 'svc',
      environment: 'dev',
      instance_id: 'host',
      affected_endpoint: '/test',
      sdk_version: '0.14.2',
      pid: 1,
      duration_ms: 100,
      is_partial: true,
      exception_info: [
        {
          exception_type: 'Error',
          exception_message: 'test',
          stack_trace: 'Error: test',
          call_path: [{ function_name: 'f1', caller_function_name: '', duration_ns: 0, error: false }],
        },
      ],
      request_context: {
        type: 'http',
        timestamp: 1706745600000,
        status_code: 500,
        custom_context: {},
      },
      telemetry_correlation: { correlation_ids: {} },
    });

    const dict = snapshot.toDict();
    const callPath = (dict.exception_info as any[])[0].call_path;
    expect(callPath[0].duration_ns).toBeUndefined();
  });

  it('toDict() should return all fields', function () {
    const snapshot = new IncidentSnapshot({
      snapshot_id: 'snap_123',
      timestamp: 1706745600000,
      severity: 'critical',
      trigger_type: 'exception',
      service: 'user-service',
      environment: 'production',
      instance_id: 'host-1',
      affected_endpoint: '/api/users',
      sdk_version: '0.14.2',
      pid: 12345,
      duration_ms: 150.5,
      exception_info: [
        {
          exception_type: 'TypeError',
          exception_message: 'bad input',
          stack_trace: 'Error: bad input\n    at Object.<anonymous>',
          call_path: [
            {
              function_name: 'func_a',
              caller_function_name: '',
              duration_ns: 1000,
              error: true,
            },
          ],
        },
      ],
      request_context: {
        type: 'http',
        timestamp: 1706745600000,
        status_code: 500,
        custom_context: {},
      },
      telemetry_correlation: {
        trace_id: 'trace-xyz',

        correlation_ids: {},
      },
    });

    const result = snapshot.toDict();
    expect(result.snapshot_id).toBe('snap_123');
    expect(result.severity).toBe('critical');
    expect(result.trigger_type).toBe('exception');
    expect(result.telemetry_type).toBe('IncidentSnapshot');
    expect(result.duration_ms).toBe(150.5);
    expect(result.is_partial).toBe(false);
    expect(result.exception_info as any[]).toHaveLength(1);
    expect((result.exception_info as any[])[0].exception_type).toBe('TypeError');
    expect((result.request_context as RequestContext).type).toBe('http');
    expect((result.telemetry_correlation as TelemetryCorrelation).trace_id).toBe('trace-xyz');
  });

  it('should default telemetry_type to IncidentSnapshot', function () {
    const snapshot = createMinimalSnapshot();
    expect(snapshot.telemetry_type).toBe('IncidentSnapshot');
  });

  it('should be JSON serializable', function () {
    const snapshot = createMinimalSnapshot();
    const json = JSON.stringify(snapshot.toDict());
    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.snapshot_id).toBe('snap_1');
  });
});
