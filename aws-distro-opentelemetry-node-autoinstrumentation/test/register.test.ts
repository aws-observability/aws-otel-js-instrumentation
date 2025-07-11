// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import { NodeSDK } from '@opentelemetry/sdk-node';
import * as assert from 'assert';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import expect from 'expect';
import { setAwsDefaultEnvironmentVariables } from '../src/register';

// The OpenTelemetry Authors code
// Extend register.test.ts functionality to also test exported span with Application Signals enabled
describe('Register', function () {
  it('Requires without error', () => {
    const originalPrototypeStart = NodeSDK.prototype.start;
    NodeSDK.prototype.start = () => {};
    try {
      require('../src/register');
    } catch (err: unknown) {
      assert.fail(`require register unexpectedly failed: ${err}`);
    }

    NodeSDK.prototype.start = originalPrototypeStart;
  });

  describe('Tests AWS Default Environment Variables', () => {
    beforeEach(() => {
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
      delete process.env.OTEL_PROPAGATORS;
      delete process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS;
      delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;

      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      delete process.env.AGENT_OBSERVABILITY_ENABLED;
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      delete process.env.OTEL_TRACES_EXPORTER;
      delete process.env.OTEL_LOGS_EXPORTER;
      delete process.env.OTEL_METRICS_EXPORTER;

      delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      delete process.env.OTEL_TRACES_SAMPLER;
      delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    });

    it('sets AWS Default Environment Variables', () => {
      setAwsDefaultEnvironmentVariables();
      expect(process.env.OTEL_EXPORTER_OTLP_PROTOCOL).toEqual('http/protobuf');
      expect(process.env.OTEL_PROPAGATORS).toEqual('baggage,xray,tracecontext');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('fs,dns');
    });

    it('Does not set AWS Default Environment Variables', () => {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'customProtocol';
      process.env.OTEL_PROPAGATORS = 'customPropagators';
      process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'customDisabledInstrumentations';
      setAwsDefaultEnvironmentVariables();
      expect(process.env.OTEL_EXPORTER_OTLP_PROTOCOL).toEqual('customProtocol');
      expect(process.env.OTEL_PROPAGATORS).toEqual('customPropagators');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('customDisabledInstrumentations');
    });

    it('Configures with AgentObservabilityEnabled with unset region', () => {
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
      expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined();
    });

    it('Configures with AgentObservabilityEnabled with set region', () => {
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
      process.env.AWS_REGION = 'us-west-2';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toEqual('https://xray.us-west-2.amazonaws.com/v1/traces');
      expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toEqual('https://logs.us-west-2.amazonaws.com/v1/logs');

      delete process.env.AWS_REGION;
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      process.env.AWS_DEFAULT_REGION = 'us-east-2';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toEqual('https://xray.us-east-2.amazonaws.com/v1/traces');
      expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toEqual('https://logs.us-east-2.amazonaws.com/v1/logs');
    });

    it('Configures defaults when AgentObservabilityEnabled is true', () => {
      process.env.AWS_REGION = 'us-east-1';
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_TRACES_EXPORTER).toEqual('otlp');
      expect(process.env.OTEL_LOGS_EXPORTER).toEqual('otlp');
      expect(process.env.OTEL_METRICS_EXPORTER).toEqual('awsemf');
      expect(process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toEqual('true');
      expect(process.env.OTEL_TRACES_SAMPLER).toEqual('parentbased_always_on');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('fs,dns');
      expect(process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS).toEqual('aws-lambda,aws-sdk,http');
      expect(process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED).toEqual('false');
      expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toEqual('https://xray.us-east-1.amazonaws.com/v1/traces');
      expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toEqual('https://logs.us-east-1.amazonaws.com/v1/logs');
    });

    it('Respects user configuration when AgentObservabilityEnabled is false', () => {
      process.env.AWS_REGION = 'us-east-1';
      delete process.env.AGENT_OBSERVABILITY_ENABLED;
      process.env.OTEL_TRACES_SAMPLER = 'traceidratio';

      setAwsDefaultEnvironmentVariables();
      expect(process.env.OTEL_TRACES_SAMPLER).toEqual('traceidratio');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('fs,dns');
      expect(process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED).toBeUndefined();
    });

    it('Respects user configuration when AgentObservabilityEnabled is true', () => {
      // Enable agent observability
      process.env.AGENT_OBSERVABILITY_ENABLED = 'true';

      // Set custom values for some environment variables
      process.env.OTEL_TRACES_SAMPLER = 'traceidratio';
      process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'a,b,c,d';
      process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';

      setAwsDefaultEnvironmentVariables();

      expect(process.env.OTEL_TRACES_SAMPLER).toEqual('traceidratio');
      expect(process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS).toEqual('a,b,c,d');
      expect(process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED).toEqual('true');
    });
  });

  it('can load auto instrumentation from command line', () => {
    const proc: SpawnSyncReturns<Buffer> = spawnSync(
      process.execPath,
      ['--require', '../build/src/register.js', './third-party/otel/test-app/app.js'],
      {
        cwd: __dirname,
        timeout: 10000,
        killSignal: 'SIGKILL', // SIGTERM is not sufficient to terminate some hangs
        env: Object.assign({}, process.env, {
          OTEL_NODE_RESOURCE_DETECTORS: 'none',
          OTEL_TRACES_EXPORTER: 'console',
          // nx (used by lerna run) defaults `FORCE_COLOR=true`, which in
          // node v18.17.0, v20.3.0 and later results in ANSI color escapes
          // in the ConsoleSpanExporter output that is checked below.
          FORCE_COLOR: '0',

          OTEL_LOG_LEVEL: 'ALL',
          OTEL_TRACES_SAMPLER: 'always_on',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4316/v1/traces',
          OTEL_RESOURCE_ATTRIBUTES: 'service.name=test-adot-sdk-ec2-service-name',
          OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'true',
          OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'fs',
        }),
      }
    );
    assert.ifError(proc.error);
    assert.equal(proc.status, 0, `proc.status (${proc.status})`);
    assert.equal(proc.signal, null, `proc.signal (${proc.signal})`);

    assert.ok(proc.stdout.includes('AWS Distro of OpenTelemetry automatic instrumentation started successfully'));
    assert.ok(proc.stdout.includes("Environment variable OTEL_EXPORTER_OTLP_PROTOCOL is set to 'http/protobuf'"));
    assert.ok(proc.stdout.includes("Environment variable OTEL_PROPAGATORS is set to 'baggage,xray,tracecontext'"));

    // Check a span has been generated for the GET request done in app.js
    assert.ok(proc.stdout.includes("name: 'GET'"), 'console span output in stdout - validate Span Name');
    assert.ok(
      proc.stdout.includes("'service.name': 'test-adot-sdk-ec2-service-name'"),
      'console span output in stdout - validate service.name'
    );

    // eslint-disable-next-line @typescript-eslint/typedef
    const packageJson = require('./../package.json');
    const DISTRO_VERSION: string = packageJson.version;
    assert.ok(
      proc.stdout.includes(`'telemetry.auto.version': '${DISTRO_VERSION}-aws'`),
      'console span output in stdout - validate telemetry.auto.version'
    );
    assert.ok(
      proc.stdout.includes("'aws.is.local.root': true"),
      'console span output in stdout - validate aws.is.local.root'
    );
    assert.ok(
      proc.stdout.includes("'aws.local.operation': 'InternalOperation'"),
      'console span output in stdout - validate aws.local.operation'
    );
    assert.ok(
      proc.stdout.includes("'aws.local.service': 'test-adot-sdk-ec2-service-name'"),
      'console span output in stdout - validate aws.local.service'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.service': 'example.com:80'"),
      'console span output in stdout - validate aws.remote.service'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.operation': 'GET /'"),
      'console span output in stdout - validate aws.remote.operation'
    );
    assert.ok(
      proc.stdout.includes("'aws.span.kind': 'LOCAL_ROOT'"),
      'console span output in stdout - validate aws.span.kind'
    );
  });
});
// END The OpenTelemetry Authors code
