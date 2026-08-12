// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Mode 2 (programmatic NodeSDK): new NodeSDK(withSpanMetrics({...})), then bind the SDK's
// MeterProvider after start.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { bind, withSpanMetrics } from '../../src';

const endpoint = process.env.COLLECTOR_ENDPOINT ?? 'http://localhost:4319';
const resource = resourceFromAttributes({ 'service.name': 'contract-programmatic' });

// The app owns its metrics pipeline and binds it — the extension records into the app's own
// MeterProvider rather than reaching into NodeSDK's internal one (whose config surface varies by
// sdk-node version). This is the documented Mode 2 pattern.
const meterProvider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 1000,
    }),
  ],
});
bind(meterProvider);

const sdk = new NodeSDK(
  withSpanMetrics({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.05) }),
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
