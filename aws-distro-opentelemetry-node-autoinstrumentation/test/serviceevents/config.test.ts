// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  createServiceEventsConfigFromEnv,
  getLatencyThresholdPatterns,
  shouldTrackEndpoint,
} from '../../src/serviceevents/config';

describe('ServiceEventsConfig', function () {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(function () {
    savedEnv = { ...process.env };
  });

  afterEach(function () {
    // Restore env without replacing the process.env object (which is a special proxy).
    // Replacing it breaks other modules that hold a reference to the original.
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // Helper to clear all SERVICE_EVENTS-related env vars so defaults are deterministic.
  // DEBUG_SE_TEST_CONFIG (the internal test-config hook) must be cleared too — otherwise
  // a value set in one test leaks into every later test that builds a config.
  function clearServiceEventsEnvVars(): void {
    const keys = Object.keys(process.env).filter(
      k =>
        k.startsWith('OTEL_AWS_SERVICE_EVENTS_') ||
        k === 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED' ||
        k === 'OTEL_SERVICE_NAME' ||
        k === 'OTEL_RESOURCE_ATTRIBUTES' ||
        k === 'ENVIRONMENT' ||
        k === 'DEBUG_SE_TEST_CONFIG'
    );
    for (const key of keys) {
      delete process.env[key];
    }
  }

  describe('createServiceEventsConfigFromEnv() with defaults', function () {
    it('should return default values when no env vars are set', function () {
      clearServiceEventsEnvVars();

      const config = createServiceEventsConfigFromEnv();

      // Default false: OTEL_AWS_SERVICE_EVENTS_ENABLED is unset by default. The outer
      // bundling gate in register.ts decides whether ServiceEvents actually runs.
      expect(config.enabled).toBe(false);
      expect(config.serviceName).toBe('UnknownService');
      // No environment default: omitted (undefined) when unset — no sentinel.
      expect(config.environment).toBeUndefined();
      expect(config.functionCallFlushInterval).toBe(30000);
      expect(config.endpointFlushInterval).toBe(30000);
      expect(config.incidentSnapshotFlushInterval).toBe(10000);
      expect(config.incidentSnapshotMaxPerMinute).toBe(100);
      expect(config.incidentSnapshotDurationThresholdMs).toBe(5000);
      expect(config.incidentSnapshotMaxSameError).toBe(1);
      expect(config.latencyThresholds).toEqual([]);
      expect(config.instrumentExpress).toBe(true);
      expect(config.instrumentFastify).toBe(true);
      expect(config.instrumentKoa).toBe(true);
      expect(config.instrumentNextJs).toBe(true);
      expect(config.endpointIncludePatterns).toEqual([]);
      expect(config.endpointExcludePatterns).toEqual([]);
      expect(config.functionInstrumentEnabled).toBe(true);
      // No implicit default scope: empty packagesInclude means no functions instrumented.
      // The non-configurable SDK_SELF_EXCLUDE (in ast-transformation.ts) is the only built-in filter.
      expect(config.packagesExclude).toEqual([]);
      expect(config.packagesInclude).toEqual([]);
      expect(config.samplingMode).toBe('adaptive');
      expect(config.functionDetachThreshold).toBe(5000);
      // Application Signals bundling flag defaults off.
      expect(config.applicationSignalsEnabled).toBe(false);
      // CloudWatch direct-OTLP log headers default to empty — emitter
      // falls back to serviceName for the stream when the header is unset.
      expect(config.logGroup).toBe('');
      expect(config.logStream).toBe('');
    });
  });

  describe('internal knobs ignore their former env vars', function () {
    it('LOG_GROUP / LOG_STREAM env vars are ignored (internal, hook-only)', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_LOG_GROUP = '/my/log/group';
      process.env.OTEL_AWS_SERVICE_EVENTS_LOG_STREAM = 'my-stream';
      const config = createServiceEventsConfigFromEnv();
      expect(config.logGroup).toBe('');
      expect(config.logStream).toBe('');
    });

    it('sampling tiers, hot-endpoint cycles, and framework toggles ignore env', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_SAMPLE_TIER1_THRESHOLD = '7';
      process.env.OTEL_AWS_SERVICE_EVENTS_SAMPLE_TIER2_THRESHOLD = '70';
      process.env.OTEL_AWS_SERVICE_EVENTS_SAMPLE_TIER2_RATE = '3';
      process.env.OTEL_AWS_SERVICE_EVENTS_SAMPLE_TIER3_RATE = '30';
      process.env.OTEL_AWS_SERVICE_EVENTS_HOT_ENDPOINT_CYCLES = '20';
      process.env.OTEL_AWS_SERVICE_EVENTS_JS_INSTRUMENT_EXPRESS = 'false';
      process.env.OTEL_AWS_SERVICE_EVENTS_JS_FUNCTION_DETACH_THRESHOLD = '99';
      const config = createServiceEventsConfigFromEnv();
      expect(config.sampleTier1Threshold).toBe(100);
      expect(config.sampleTier2Threshold).toBe(1000);
      expect(config.sampleTier2Rate).toBe(10);
      expect(config.sampleTier3Rate).toBe(100);
      expect(config.hotEndpointCycles).toBe(100);
      expect(config.instrumentExpress).toBe(true);
      expect(config.functionDetachThreshold).toBe(5000);
    });

    it('flush-interval and SDK_VERSION env vars are ignored', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_FUNCTION_CALL_FLUSH_INTERVAL = '5000';
      process.env.OTEL_AWS_SERVICE_EVENTS_ENDPOINT_FLUSH_INTERVAL = '6000';
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_FLUSH_INTERVAL = '2000';
      process.env.OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_EVENT_FLUSH_INTERVAL = '1000';
      process.env.OTEL_AWS_SERVICE_EVENTS_SDK_VERSION = '9.9.9-fake';
      const config = createServiceEventsConfigFromEnv();
      expect(config.functionCallFlushInterval).toBe(30000);
      expect(config.endpointFlushInterval).toBe(30000);
      expect(config.incidentSnapshotFlushInterval).toBe(10000);
      expect(config.deploymentEventFlushInterval).toBe(86_400_000);
      expect(config.sdkVersion).not.toBe('9.9.9-fake');
    });
  });

  describe('internal test-config hook (DEBUG_SE_TEST_CONFIG)', function () {
    it('is a no-op when unset — defaults stand', function () {
      clearServiceEventsEnvVars();
      const config = createServiceEventsConfigFromEnv();
      expect(config.endpointFlushInterval).toBe(30000);
      expect(config.sampleTier1Threshold).toBe(100);
      expect(config.logGroup).toBe('');
    });

    it('overrides recognized keys', function () {
      clearServiceEventsEnvVars();
      process.env.DEBUG_SE_TEST_CONFIG =
        'FUNCTION_CALL_FLUSH_INTERVAL=2000;ENDPOINT_FLUSH_INTERVAL=2500;' +
        'INCIDENT_SNAPSHOT_FLUSH_INTERVAL=1500;' +
        'SAMPLE_TIER1_THRESHOLD=7;SAMPLE_TIER2_THRESHOLD=70;SAMPLE_TIER2_RATE=3;' +
        'SAMPLE_TIER3_RATE=30;' +
        'LOG_GROUP=/test/group;LOG_STREAM=test-stream';
      const config = createServiceEventsConfigFromEnv();
      expect(config.functionCallFlushInterval).toBe(2000);
      expect(config.endpointFlushInterval).toBe(2500);
      expect(config.incidentSnapshotFlushInterval).toBe(1500);
      expect(config.sampleTier1Threshold).toBe(7);
      expect(config.sampleTier2Threshold).toBe(70);
      expect(config.sampleTier2Rate).toBe(3);
      expect(config.sampleTier3Rate).toBe(30);
      expect(config.logGroup).toBe('/test/group');
      expect(config.logStream).toBe('test-stream');
    });

    it('ignores unknown keys and unparsable values', function () {
      clearServiceEventsEnvVars();
      process.env.DEBUG_SE_TEST_CONFIG = 'UNKNOWN_KEY=1;ENDPOINT_FLUSH_INTERVAL=notanint;LOG_GROUP=/ok';
      const config = createServiceEventsConfigFromEnv();
      // Garbage int keeps the default; valid string key still applies; unknown key is ignored.
      expect(config.endpointFlushInterval).toBe(30000);
      expect(config.logGroup).toBe('/ok');
    });

    it('does not leak across createServiceEventsConfigFromEnv() calls after clear', function () {
      clearServiceEventsEnvVars();
      process.env.DEBUG_SE_TEST_CONFIG = 'LOG_GROUP=/leak/check';
      expect(createServiceEventsConfigFromEnv().logGroup).toBe('/leak/check');
      // clearServiceEventsEnvVars must drop DEBUG_SE_TEST_CONFIG, else it leaks here.
      clearServiceEventsEnvVars();
      expect(createServiceEventsConfigFromEnv().logGroup).toBe('');
    });
  });

  describe('applicationSignalsEnabled env binding', function () {
    it('mirrors OTEL_AWS_APPLICATION_SIGNALS_ENABLED=true', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
      const config = createServiceEventsConfigFromEnv();
      expect(config.applicationSignalsEnabled).toBe(true);
    });

    it('stays false when OTEL_AWS_APPLICATION_SIGNALS_ENABLED is unset', function () {
      clearServiceEventsEnvVars();
      delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
      const config = createServiceEventsConfigFromEnv();
      expect(config.applicationSignalsEnabled).toBe(false);
    });
  });

  describe('createServiceEventsConfigFromEnv() with custom env vars', function () {
    it('should pick up custom values from release env vars', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = 'false';
      process.env.OTEL_SERVICE_NAME = 'test-svc';
      process.env.ENVIRONMENT = 'staging';
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE = '10';
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_DURATION_THRESHOLD_MS = '1000';
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_SAME_ERROR = '5';
      process.env.OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED = 'false';
      process.env.OTEL_AWS_SERVICE_EVENTS_SAMPLING_MODE = 'always';

      const config = createServiceEventsConfigFromEnv();

      expect(config.enabled).toBe(false);
      expect(config.serviceName).toBe('test-svc');
      expect(config.environment).toBe('staging');
      expect(config.incidentSnapshotMaxPerMinute).toBe(10);
      expect(config.incidentSnapshotDurationThresholdMs).toBe(1000);
      expect(config.incidentSnapshotMaxSameError).toBe(5);
      // FUNCTION_INSTRUMENT_ENABLED=false above overrides the (now true) default.
      expect(config.functionInstrumentEnabled).toBe(false);
      expect(config.samplingMode).toBe('always');
    });
  });

  describe('createServiceEventsConfigFromEnv() with comma-separated list env vars', function () {
    it('should parse OTEL_AWS_SERVICE_EVENTS_PACKAGES_EXCLUDE as the packagesExclude list', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_PACKAGES_EXCLUDE = 'dist/*,build/*';

      const config = createServiceEventsConfigFromEnv();

      // The non-configurable SDK_SELF_EXCLUDE lives in ast-transformation.ts and is applied
      // by the matcher separately; PACKAGES_EXCLUDE is the user denylist.
      expect(config.packagesExclude).toEqual(['dist/*', 'build/*']);
    });

    it('rule 1: empty PACKAGES_INCLUDE means no functions instrumented', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED = 'true';
      // No PACKAGES_INCLUDE set.
      const config = createServiceEventsConfigFromEnv();
      expect(config.functionInstrumentEnabled).toBe(true);
      expect(config.packagesInclude).toEqual([]);
    });

    it('normalizes bare "*" in PACKAGES_INCLUDE to empty (invalid input)', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE = '*';
      const config = createServiceEventsConfigFromEnv();
      expect(config.packagesInclude).toEqual([]);
    });

    it('strips bare "*" from mixed PACKAGES_INCLUDE list', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE = 'src/myapp/**,*,src/lib/**';
      const config = createServiceEventsConfigFromEnv();
      expect(config.packagesInclude).toEqual(['src/myapp/**', 'src/lib/**']);
    });

    it('normalizes bare "*" in PACKAGES_EXCLUDE to empty', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_PACKAGES_EXCLUDE = '*';
      const config = createServiceEventsConfigFromEnv();
      expect(config.packagesExclude).toEqual([]);
    });

    it('normalizes bare "**" in PACKAGES_INCLUDE to empty (minimatch match-all sentinel)', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE = '**';
      const config = createServiceEventsConfigFromEnv();
      expect(config.packagesInclude).toEqual([]);
    });

    it('strips bare "**" from mixed PACKAGES_INCLUDE list but keeps path-globs with double-star', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE = 'src/myapp/**,**,src/lib/**';
      const config = createServiceEventsConfigFromEnv();
      // Lone "**" is rejected; "src/myapp/**" and "src/lib/**" are valid path-bounded globs.
      expect(config.packagesInclude).toEqual(['src/myapp/**', 'src/lib/**']);
    });

    it('should trim whitespace from list entries', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_PACKAGES_EXCLUDE = ' dist/* , build/* ';

      const config = createServiceEventsConfigFromEnv();

      expect(config.packagesExclude).toEqual(['dist/*', 'build/*']);
    });

    it('should filter out empty entries from list', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_PACKAGES_EXCLUDE = 'dist/*,,build/*,';

      const config = createServiceEventsConfigFromEnv();

      expect(config.packagesExclude).toEqual(['dist/*', 'build/*']);
    });

    it('should parse endpoint include and exclude patterns', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENDPOINT_INCLUDE_PATTERNS = 'GET /api/*,POST /api/*';
      process.env.OTEL_AWS_SERVICE_EVENTS_ENDPOINT_EXCLUDE_PATTERNS = '* /health,* /metrics';

      const config = createServiceEventsConfigFromEnv();

      expect(config.endpointIncludePatterns).toEqual(['GET /api/*', 'POST /api/*']);
      expect(config.endpointExcludePatterns).toEqual(['* /health', '* /metrics']);
    });

    it('should parse OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE as comma-separated list', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE = 'my-lib,another-lib';

      const config = createServiceEventsConfigFromEnv();

      expect(config.packagesInclude).toEqual(['my-lib', 'another-lib']);
    });
  });

  describe('createServiceEventsConfigFromEnv() with invalid int falls back to default', function () {
    it('should use default when int env var is not a valid number', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE = 'abc';
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_DURATION_THRESHOLD_MS = 'not-a-number';

      const config = createServiceEventsConfigFromEnv();

      expect(config.incidentSnapshotMaxPerMinute).toBe(100);
      expect(config.incidentSnapshotDurationThresholdMs).toBe(5000);
    });

    it('should use default when int env var is empty string', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE = '';

      const config = createServiceEventsConfigFromEnv();

      // Empty string -> parseInt returns NaN -> fallback to default
      expect(config.incidentSnapshotMaxPerMinute).toBe(100);
    });
  });

  describe('boolean parsing is case-insensitive', function () {
    it('should treat TRUE (uppercase) as true', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = 'TRUE';

      const config = createServiceEventsConfigFromEnv();

      expect(config.enabled).toBe(true);
    });

    it('should treat True (mixed case) as true', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = 'True';

      const config = createServiceEventsConfigFromEnv();

      expect(config.enabled).toBe(true);
    });

    it('should treat tRuE (random case) as true', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = 'tRuE';

      const config = createServiceEventsConfigFromEnv();

      expect(config.enabled).toBe(true);
    });
  });

  describe('non-true values for bools are treated as false', function () {
    it('should treat "yes" as false', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = 'yes';

      const config = createServiceEventsConfigFromEnv();

      expect(config.enabled).toBe(false);
    });

    it('should treat "1" as false', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = '1';

      const config = createServiceEventsConfigFromEnv();

      expect(config.enabled).toBe(false);
    });

    it('should treat "on" as false', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = 'on';

      const config = createServiceEventsConfigFromEnv();

      expect(config.enabled).toBe(false);
    });

    it('should treat empty string as false', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = '';

      const config = createServiceEventsConfigFromEnv();

      expect(config.enabled).toBe(false);
    });
  });

  describe('getLatencyThresholdPatterns()', function () {
    it('should parse valid entries into pattern-threshold tuples', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS =
        'GET /api/users:500,* /server_request:50,POST /api/*:100';

      const config = createServiceEventsConfigFromEnv();
      const patterns = getLatencyThresholdPatterns(config);

      expect(patterns.length).toBe(3);
      expect(patterns[0]).toEqual(['GET /api/users', 500]);
      expect(patterns[1]).toEqual(['* /server_request', 50]);
      expect(patterns[2]).toEqual(['POST /api/*', 100]);
    });

    it('should return empty array for no thresholds', function () {
      clearServiceEventsEnvVars();

      const config = createServiceEventsConfigFromEnv();
      const patterns = getLatencyThresholdPatterns(config);

      expect(patterns).toEqual([]);
    });

    it('should skip entries without a space (invalid METHOD /route format)', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS = '/no-method:100,GET /valid:200';

      const config = createServiceEventsConfigFromEnv();
      const patterns = getLatencyThresholdPatterns(config);

      expect(patterns.length).toBe(1);
      expect(patterns[0]).toEqual(['GET /valid', 200]);
    });

    it('should uppercase the method', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS = 'get /api/test:300';

      const config = createServiceEventsConfigFromEnv();
      const patterns = getLatencyThresholdPatterns(config);

      expect(patterns.length).toBe(1);
      expect(patterns[0]).toEqual(['GET /api/test', 300]);
    });

    it('should skip entries with a non-numeric threshold', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS = 'POST /api/checkout:500,GET /api/health:abc';

      const config = createServiceEventsConfigFromEnv();
      const patterns = getLatencyThresholdPatterns(config);

      // Only the entry with a numeric threshold survives.
      expect(patterns).toEqual([['POST /api/checkout', 500]]);
    });

    it('should split on the last colon so routes may contain colons', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS = 'GET /api/v1:resource:200';

      const config = createServiceEventsConfigFromEnv();
      const patterns = getLatencyThresholdPatterns(config);

      expect(patterns).toEqual([['GET /api/v1:resource', 200]]);
    });

    it('should reject non-positive thresholds (0 / negative would fire on every request)', function () {
      // A 0 or negative per-endpoint threshold would make durationMs > thresholdMs
      // true for every request to the route — flagging healthy traffic as latency
      // incidents. Such entries are dropped so the route uses the global default.
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_LATENCY_THRESHOLDS =
        'GET /zero:0,GET /neg:-50,GET /ok:250';

      const config = createServiceEventsConfigFromEnv();
      const patterns = getLatencyThresholdPatterns(config);

      // Only the positive threshold survives.
      expect(patterns).toEqual([['GET /ok', 250]]);
    });
  });

  describe('shouldTrackEndpoint()', function () {
    it('should track all endpoints when no include/exclude patterns are set', function () {
      clearServiceEventsEnvVars();

      const config = createServiceEventsConfigFromEnv();

      expect(shouldTrackEndpoint(config, '/api/users', 'GET')).toBe(true);
      expect(shouldTrackEndpoint(config, '/health', 'GET')).toBe(true);
      expect(shouldTrackEndpoint(config, '/anything', 'POST')).toBe(true);
    });

    it('should only track endpoints matching include patterns', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENDPOINT_INCLUDE_PATTERNS = 'GET /api/*,POST /api/*';

      const config = createServiceEventsConfigFromEnv();

      expect(shouldTrackEndpoint(config, '/api/users', 'GET')).toBe(true);
      expect(shouldTrackEndpoint(config, '/api/orders', 'POST')).toBe(true);
      expect(shouldTrackEndpoint(config, '/health', 'GET')).toBe(false);
      expect(shouldTrackEndpoint(config, '/api/users', 'DELETE')).toBe(false);
    });

    it('should exclude endpoints matching exclude patterns', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENDPOINT_EXCLUDE_PATTERNS = '* /health,* /metrics';

      const config = createServiceEventsConfigFromEnv();

      expect(shouldTrackEndpoint(config, '/api/users', 'GET')).toBe(true);
      expect(shouldTrackEndpoint(config, '/health', 'GET')).toBe(false);
      expect(shouldTrackEndpoint(config, '/metrics', 'GET')).toBe(false);
    });

    it('should apply exclude patterns after include patterns', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENDPOINT_INCLUDE_PATTERNS = '* /api/*';
      process.env.OTEL_AWS_SERVICE_EVENTS_ENDPOINT_EXCLUDE_PATTERNS = '* /api/internal/*';

      const config = createServiceEventsConfigFromEnv();

      expect(shouldTrackEndpoint(config, '/api/users', 'GET')).toBe(true);
      expect(shouldTrackEndpoint(config, '/api/internal/debug', 'GET')).toBe(false);
      expect(shouldTrackEndpoint(config, '/health', 'GET')).toBe(false);
    });

    it('should be case-insensitive for HTTP method matching', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_AWS_SERVICE_EVENTS_ENDPOINT_INCLUDE_PATTERNS = 'GET /api/*';

      const config = createServiceEventsConfigFromEnv();

      // shouldTrackEndpoint uppercases the method
      expect(shouldTrackEndpoint(config, '/api/users', 'get')).toBe(true);
      expect(shouldTrackEndpoint(config, '/api/users', 'Get')).toBe(true);
    });
  });

  describe('service name from OTEL_RESOURCE_ATTRIBUTES', function () {
    it('should read service.name from OTEL_RESOURCE_ATTRIBUTES', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=my-service,deployment.environment=prod';

      const config = createServiceEventsConfigFromEnv();

      expect(config.serviceName).toBe('my-service');
    });

    it('should prefer OTEL_SERVICE_NAME over OTEL_RESOURCE_ATTRIBUTES', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_SERVICE_NAME = 'from-service-name';
      process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=from-resource-attrs';

      const config = createServiceEventsConfigFromEnv();

      expect(config.serviceName).toBe('from-service-name');
    });

    it('should fall back to default when neither env var is set', function () {
      clearServiceEventsEnvVars();

      const config = createServiceEventsConfigFromEnv();

      expect(config.serviceName).toBe('UnknownService');
    });

    it('should handle OTEL_RESOURCE_ATTRIBUTES with service.name containing equals sign', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=svc=special,other=val';

      const config = createServiceEventsConfigFromEnv();

      expect(config.serviceName).toBe('svc=special');
    });
  });

  describe('environment from OTEL_RESOURCE_ATTRIBUTES', function () {
    it('should read deployment.environment from OTEL_RESOURCE_ATTRIBUTES', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=svc,deployment.environment=production';

      const config = createServiceEventsConfigFromEnv();

      expect(config.environment).toBe('production');
    });

    it('should prefer deployment.environment.name over deployment.environment', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_RESOURCE_ATTRIBUTES =
        'deployment.environment.name=from-new-convention,deployment.environment=from-old-convention';

      const config = createServiceEventsConfigFromEnv();

      expect(config.environment).toBe('from-new-convention');
    });

    it('should prefer deployment.environment.name even when listed AFTER deployment.environment', function () {
      // Regression: the resolver must scan all pairs and prefer .name regardless of
      // ordering. Returning on the first matching key let the legacy value win when
      // it appeared first.
      clearServiceEventsEnvVars();

      process.env.OTEL_RESOURCE_ATTRIBUTES =
        'deployment.environment=from-old-convention,deployment.environment.name=from-new-convention';

      const config = createServiceEventsConfigFromEnv();

      expect(config.environment).toBe('from-new-convention');
    });

    it('should fall back to ENVIRONMENT env var when not in resource attributes', function () {
      clearServiceEventsEnvVars();

      process.env.ENVIRONMENT = 'staging';

      const config = createServiceEventsConfigFromEnv();

      expect(config.environment).toBe('staging');
    });

    it('should prefer OTEL_RESOURCE_ATTRIBUTES over ENVIRONMENT env var', function () {
      clearServiceEventsEnvVars();

      process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment=from-resource';
      process.env.ENVIRONMENT = 'from-env';

      const config = createServiceEventsConfigFromEnv();

      expect(config.environment).toBe('from-resource');
    });

    it('should be undefined (omitted, no sentinel) when no environment is set', function () {
      clearServiceEventsEnvVars();

      const config = createServiceEventsConfigFromEnv();

      expect(config.environment).toBeUndefined();
    });
  });

  describe('numeric config bounds validation (clamping)', function () {
    it('clamps zero / negative incident max-per-minute up to the minimum', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE = '0';
      expect(createServiceEventsConfigFromEnv().incidentSnapshotMaxPerMinute).toBe(1);
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE = '-5';
      expect(createServiceEventsConfigFromEnv().incidentSnapshotMaxPerMinute).toBe(1);
    });

    it('clamps an absurdly large incident max-per-minute down to the maximum', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE = '99999999';
      expect(createServiceEventsConfigFromEnv().incidentSnapshotMaxPerMinute).toBe(100_000);
    });

    it('clamps duration threshold and max-same-error to their ranges', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_DURATION_THRESHOLD_MS = '0';
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_SAME_ERROR = '0';
      const config = createServiceEventsConfigFromEnv();
      expect(config.incidentSnapshotDurationThresholdMs).toBe(1);
      expect(config.incidentSnapshotMaxSameError).toBe(1);
    });

    it('falls back to default on non-numeric input', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE = 'abc';
      // Default is 100 (see DEFAULTS); non-numeric -> default, not NaN.
      const v = createServiceEventsConfigFromEnv().incidentSnapshotMaxPerMinute;
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBe(100);
    });

    it('accepts an in-range value unchanged', function () {
      clearServiceEventsEnvVars();
      process.env.OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE = '250';
      expect(createServiceEventsConfigFromEnv().incidentSnapshotMaxPerMinute).toBe(250);
    });
  });
});
