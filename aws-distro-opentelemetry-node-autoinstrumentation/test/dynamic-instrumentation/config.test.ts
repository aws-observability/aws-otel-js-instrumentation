// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { createDynamicInstrumentationConfig } from '../../src/dynamic-instrumentation/config';

describe('DynamicInstrumentationConfig', function () {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(function () {
    savedEnv = { ...process.env };
  });

  afterEach(function () {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function clearDIEnvVars(): void {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OTEL_AWS_DYNAMIC_INSTRUMENTATION_')) {
        delete process.env[key];
      }
    }
  }

  it('should use defaults when no env vars set', function () {
    clearDIEnvVars();
    const config = createDynamicInstrumentationConfig();
    expect(config.enabled).toBe(false);
    expect(config.apiUrl).toBe('http://localhost:2000');
    expect(config.probePollIntervalSeconds).toBe(600);
    expect(config.breakpointPollIntervalSeconds).toBe(60);
    expect(config.outputDirectory).toBe('aws-di-snapshots');
  });

  it('should respect OTEL_AWS_DYNAMIC_INSTRUMENTATION_ENABLED=true', function () {
    clearDIEnvVars();
    process.env.OTEL_AWS_DYNAMIC_INSTRUMENTATION_ENABLED = 'true';
    const config = createDynamicInstrumentationConfig();
    expect(config.enabled).toBe(true);
  });

  it('should respect OTEL_AWS_DYNAMIC_INSTRUMENTATION_ENABLED=false', function () {
    clearDIEnvVars();
    process.env.OTEL_AWS_DYNAMIC_INSTRUMENTATION_ENABLED = 'false';
    const config = createDynamicInstrumentationConfig();
    expect(config.enabled).toBe(false);
  });

  it('should parse API URL', function () {
    clearDIEnvVars();
    process.env.OTEL_AWS_DYNAMIC_INSTRUMENTATION_API_URL = 'http://myhost:9999';
    const config = createDynamicInstrumentationConfig();
    expect(config.apiUrl).toBe('http://myhost:9999');
  });

  it('should clamp poll intervals to min/max range', function () {
    clearDIEnvVars();
    process.env.OTEL_AWS_DYNAMIC_INSTRUMENTATION_BREAKPOINT_POLL_INTERVAL = '1'; // below min (5)
    const config = createDynamicInstrumentationConfig();
    expect(config.breakpointPollIntervalSeconds).toBe(5);
  });

  it('should clamp high poll interval', function () {
    clearDIEnvVars();
    process.env.OTEL_AWS_DYNAMIC_INSTRUMENTATION_PROBE_POLL_INTERVAL = '999999'; // above max (86400)
    const config = createDynamicInstrumentationConfig();
    expect(config.probePollIntervalSeconds).toBe(86400);
  });

  it('should handle invalid poll interval', function () {
    clearDIEnvVars();
    process.env.OTEL_AWS_DYNAMIC_INSTRUMENTATION_BREAKPOINT_POLL_INTERVAL = 'not-a-number';
    const config = createDynamicInstrumentationConfig();
    expect(config.breakpointPollIntervalSeconds).toBe(60); // default
  });

  it('should trim whitespace from env vars', function () {
    clearDIEnvVars();
    process.env.OTEL_AWS_DYNAMIC_INSTRUMENTATION_API_URL = '  http://trimmed:2000  ';
    const config = createDynamicInstrumentationConfig();
    expect(config.apiUrl).toBe('http://trimmed:2000');
  });

  it('should resolve service name from OTEL_SERVICE_NAME', function () {
    clearDIEnvVars();
    process.env.OTEL_SERVICE_NAME = 'my-service';
    const config = createDynamicInstrumentationConfig();
    expect(config.serviceName).toBe('my-service');
  });

  it('should resolve service name from OTEL_RESOURCE_ATTRIBUTES', function () {
    clearDIEnvVars();
    delete process.env.OTEL_SERVICE_NAME;
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=res-svc,other=val';
    const config = createDynamicInstrumentationConfig();
    expect(config.serviceName).toBe('res-svc');
  });

  it('should resolve environment from OTEL_RESOURCE_ATTRIBUTES', function () {
    clearDIEnvVars();
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment.name=prod';
    const config = createDynamicInstrumentationConfig();
    expect(config.environment).toBe('prod');
  });

  it('should default service name to unknown_service', function () {
    clearDIEnvVars();
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    const config = createDynamicInstrumentationConfig();
    expect(config.serviceName).toBe('unknown_service');
  });
});
