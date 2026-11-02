// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared setup for the per-family attribute contract tests (analog of Java's FamilyTestBase). Family
// tests verify only attribute shape, so they all run against one representative mode (zero-code) with
// real HTTP/Express instrumentation. Each family test file starts its own collector + app on a
// distinct port via startFamilyApp(), then asserts on the metric datapoints the mock collector saw.
//
// Base and HTTP families are covered live here. DB/RPC/messaging attribute derivation is currently
// unit-tested against spec-defined keys (span-metrics-attributes-builder.test.ts); live,
// instrumentation-driven coverage for those families needs real backends (Docker) and is tracked
// separately.
import * as path from 'path';
import { MockCollector } from '../utils/mock-collector';
import { runApp } from '../utils/run-app';

const OUR_REGISTER = path.resolve(__dirname, '..', '..', '..', 'build', 'src', 'register.js');
const UPSTREAM_REGISTER = '@opentelemetry/auto-instrumentations-node/register';

export const FAMILY_SERVICE_NAME = 'contract-family';

// Starts a mock collector and drives the zero-code app once against it. Returns the collector so the
// caller can read the datapoints it captured. Ports are passed in so each family file is isolated.
export async function startFamilyApp(opts: {
  collectorPort: number;
  appPort: number;
  drivePath?: string;
}): Promise<MockCollector> {
  const endpoint = `http://localhost:${opts.collectorPort}`;
  const collector = new MockCollector();
  await collector.start(opts.collectorPort);
  await runApp({
    app: 'zerocode-app',
    requires: [OUR_REGISTER, UPSTREAM_REGISTER],
    appPort: opts.appPort,
    collectorEndpoint: endpoint,
    drivePath: opts.drivePath ?? '/items/42',
    builtJs: true,
    env: {
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.05',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_METRIC_EXPORT_INTERVAL: '1000',
      OTEL_METRIC_EXPORT_TIMEOUT: '500',
      OTEL_BSP_SCHEDULE_DELAY: '500',
      OTEL_NODE_EXPERIMENTAL_SDK_METRICS: 'true',
      OTEL_NODE_RESOURCE_DETECTORS: 'env',
      OTEL_SERVICE_NAME: FAMILY_SERVICE_NAME,
    },
  });
  return collector;
}
