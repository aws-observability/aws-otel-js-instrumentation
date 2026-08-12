// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Mode (wiring) contract tests: for each integration mode, assert the extension is active and
// generating metrics from 100% of spans while trace export stays at the sampling rate, and that the
// schema marker is present. Attribute shape is covered separately by the family tests.
import * as assert from 'assert';
import * as path from 'path';
import { MockCollector } from './utils/mock-collector';
import { runApp } from './utils/run-app';
import { REQUEST_COUNT, SERVER_SPAN_NAME } from '../apps/workload';

const COLLECTOR_PORT = 4319;
const COLLECTOR_ENDPOINT = `http://localhost:${COLLECTOR_PORT}`;

// register patch chain for Mode 1: our built register, then upstream register.
const OUR_REGISTER = path.resolve(__dirname, '..', '..', 'build', 'src', 'register.js');
const UPSTREAM_REGISTER = '@opentelemetry/auto-instrumentations-node/register';

const SAMPLING_ENV = {
  OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
  OTEL_TRACES_SAMPLER_ARG: '0.05',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR_ENDPOINT,
  OTEL_METRIC_EXPORT_INTERVAL: '1000',
  OTEL_METRIC_EXPORT_TIMEOUT: '500',
  OTEL_BSP_SCHEDULE_DELAY: '500',
  OTEL_NODE_EXPERIMENTAL_SDK_METRICS: 'true',
  OTEL_NODE_RESOURCE_DETECTORS: 'env',
  OTEL_SERVICE_NAME: 'contract-zerocode',
};

interface Mode {
  name: string;
  app: string;
  requires?: string[];
  env: Record<string, string>;
  port: number;
  builtJs?: boolean;
}

const MODES: Mode[] = [
  { name: 'manual', app: 'manual-app', env: {}, port: 8110 },
  { name: 'programmatic', app: 'programmatic-app', env: {}, port: 8120 },
  { name: 'programmatic (traceExporter-only)', app: 'programmatic-traceexporter-app', env: {}, port: 8150 },
  {
    name: 'zero-code',
    app: 'zerocode-app',
    requires: [OUR_REGISTER, UPSTREAM_REGISTER],
    env: SAMPLING_ENV,
    port: 8130,
    builtJs: true,
  },
];

describe('Contract: mode wiring', function () {
  this.timeout(90000);
  let collector: MockCollector;

  before(async () => {
    collector = new MockCollector();
    await collector.start(COLLECTOR_PORT);
  });
  after(async () => collector.stop());

  for (const mode of MODES) {
    describe(`mode: ${mode.name}`, () => {
      before(async function () {
        this.timeout(60000);
        collector.reset();
        await runApp({
          app: mode.app,
          requires: mode.requires,
          env: mode.env,
          appPort: mode.port,
          collectorEndpoint: COLLECTOR_ENDPOINT,
          drivePath: '/items/42',
          builtJs: mode.builtJs,
        });
      });

      it('counts 100% of spans while traces are sampled below the request count', () => {
        assert.strictEqual(
          collector.callsValue(SERVER_SPAN_NAME),
          REQUEST_COUNT,
          `calls for ${SERVER_SPAN_NAME} should equal ${REQUEST_COUNT}`
        );
        assert.ok(
          collector.countExportedSpans(SERVER_SPAN_NAME) < REQUEST_COUNT,
          'exported spans should be sampled below the full request count'
        );
      });

      it('emits both metrics with the schema marker and seconds unit', () => {
        const attrs = collector.callsAttributes(SERVER_SPAN_NAME);
        assert.ok(attrs, 'calls datapoint present');
        assert.strictEqual(attrs!['aws.otel.span.metrics.schema'], 'v1');
        assert.ok(collector.hasDuration(SERVER_SPAN_NAME), 'duration datapoint present');
        assert.strictEqual(collector.durationUnitSeen(), 's');
      });
    });
  }
});
