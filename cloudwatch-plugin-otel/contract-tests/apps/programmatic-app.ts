// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Mode 2 (programmatic NodeSDK): new NodeSDK(withSpanMetrics({...})) with NO bind() call.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { withSpanMetrics } from '../../src';

const endpoint = process.env.COLLECTOR_ENDPOINT ?? 'http://localhost:4319';
const resource = resourceFromAttributes({ 'service.name': 'contract-programmatic' });

// No bind() here: NodeSDK builds a MeterProvider from metricReaders below and registers it as
// the global provider; the extension resolves that global provider on its own. This is the standard
// Mode 2 flow — an explicit bind() is only for a MeterProvider deliberately kept non-global, which
// the manual mode (manual-app.ts) covers.
const metricReader = new PeriodicExportingMetricReader({
  exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
  exportIntervalMillis: 1000,
});

const sdk = new NodeSDK(
  withSpanMetrics({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.5) }),
    // Both keys for version compatibility: metricReaders is the current option (the singular
    // metricReader is deprecated), but it does not exist before sdk-node 0.219 - on the FIELD-floor
    // versions this suite also runs against, only the singular is read. NodeSDK prefers the plural
    // when both are set, so current versions never see (or warn about) the singular.
    metricReaders: [metricReader],
    metricReader,
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }), {
        scheduledDelayMillis: 500,
      }),
    ],
    instrumentations: [getNodeAutoInstrumentations()],
  })
);
sdk.start();

// Require the workload only after sdk.start() has registered instrumentations, so `http` is patched
// before the workload loads it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
void (require('./workload') as typeof import('./workload')).runWorkload();
