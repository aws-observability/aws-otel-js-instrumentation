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
  // 50% (not 5%) so the exported-span count has a deterministic floor: across REQUEST_COUNT spans,
  // getting exactly zero exported is astronomically unlikely, letting the test assert both that
  // sampling still drops spans (< REQUEST_COUNT) and that export is not lost entirely (> 0).
  OTEL_TRACES_SAMPLER_ARG: '0.5',
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
  // The service.name the app's SDK resource carries; the metric RESOURCE must carry it too. This
  // pins the resource contract per wiring mode (service.name is not a datapoint attribute), which
  // the no-bind programmatic modes rely on: the extension must resolve the SDK-owned,
  // correctly-resourced provider, not some other one.
  serviceName: string;
}

const MODES: Mode[] = [
  { name: 'manual', app: 'manual-app', env: {}, port: 8110, serviceName: 'contract-manual' },
  { name: 'programmatic', app: 'programmatic-app', env: {}, port: 8120, serviceName: 'contract-programmatic' },
  {
    name: 'programmatic (traceExporter-only)',
    app: 'programmatic-traceexporter-app',
    // withSpanMetrics builds the batch processor from traceExporter with the default 5s flush; shorten
    // it so spans flush within the app's pre-exit window (otherwise export appears as 0).
    env: { OTEL_BSP_SCHEDULE_DELAY: '500' },
    port: 8150,
    serviceName: 'contract-programmatic-traceexporter',
  },
  {
    name: 'zero-code',
    app: 'zerocode-app',
    requires: [OUR_REGISTER, UPSTREAM_REGISTER],
    env: SAMPLING_ENV,
    port: 8130,
    builtJs: true,
    serviceName: 'contract-zerocode',
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
        // Two-sided bound: below the full count proves sampling still drops spans; above zero proves
        // the extension did not silently drop the user's span export (guards the B3-class regression,
        // which a one-sided `< REQUEST_COUNT` would have passed at zero).
        const exported = collector.countExportedSpans(SERVER_SPAN_NAME);
        assert.ok(
          exported > 0 && exported < REQUEST_COUNT,
          `exported spans should be sampled: 0 < ${exported} < ${REQUEST_COUNT}`
        );
      });

      it('emits both metrics with the schema marker and seconds unit', () => {
        const attrs = collector.callsAttributes(SERVER_SPAN_NAME);
        assert.ok(attrs, 'calls datapoint present');
        assert.strictEqual(attrs!['aws.otel.span.metrics.schema'], 'v1');
        assert.ok(collector.hasDuration(SERVER_SPAN_NAME), 'duration datapoint present');
        assert.strictEqual(collector.durationUnitSeen(), 's');
      });

      it("carries the app's service.name on the metric resource", () => {
        // service.name is a resource attribute, not a datapoint dimension. Asserting the exact
        // per-mode value proves the extension recorded into the app's correctly-resourced
        // MeterProvider (in the no-bind modes: the one NodeSDK registered globally) - a wrong or
        // default-resourced provider would surface as unknown_service here while counts stay green.
        const resource = collector.metricResourceAttributes();
        assert.ok(resource, 'metric resource attributes present');
        assert.strictEqual(resource!['service.name'], mode.serviceName);
      });
    });
  }

  // B5/B1 end-to-end: a user who configures OTEL_TRACES_SAMPLER=always_off should still get 100%
  // metrics (record-forcing wraps the env sampler) while exporting zero spans. This is the real
  // user config that a broken env-sampler resolver would turn into zero metrics.
  describe('zero-code with OTEL_TRACES_SAMPLER=always_off', () => {
    before(async function () {
      this.timeout(60000);
      collector.reset();
      await runApp({
        app: 'zerocode-app',
        requires: [OUR_REGISTER, UPSTREAM_REGISTER],
        env: { ...SAMPLING_ENV, OTEL_TRACES_SAMPLER: 'always_off', OTEL_TRACES_SAMPLER_ARG: '' },
        appPort: 8131,
        collectorEndpoint: COLLECTOR_ENDPOINT,
        drivePath: '/items/42',
        builtJs: true,
      });
    });

    it('meters 100% of spans while exporting none', () => {
      assert.strictEqual(
        collector.callsValue(SERVER_SPAN_NAME),
        REQUEST_COUNT,
        'record-forcing must meter every span even when the user samples nothing'
      );
      assert.strictEqual(
        collector.countExportedSpans(SERVER_SPAN_NAME),
        0,
        'always_off must still export zero spans (record-forcing does not change export)'
      );
    });
  });
});
