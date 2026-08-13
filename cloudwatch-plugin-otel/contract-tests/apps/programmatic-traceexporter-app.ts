// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Mode 2 variant: NodeSDK configured with ONLY traceExporter (no spanProcessors) — the shape that
// regresses if withSpanMetrics naively sets spanProcessors (NodeSDK would then ignore traceExporter
// and drop span export). Asserts both spans still export AND metrics are 100%.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { bind, withSpanMetrics } from '../../src';

const endpoint = process.env.COLLECTOR_ENDPOINT ?? 'http://localhost:4319';
const resource = resourceFromAttributes({ 'service.name': 'contract-programmatic-traceexporter' });

const meterProvider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 1000,
      exportTimeoutMillis: 500,
    }),
  ],
});
bind(meterProvider);

// Note: ONLY traceExporter is set here — no spanProcessors.
const sdk = new NodeSDK(
  withSpanMetrics({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.5) }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations()],
  })
);
sdk.start();

// eslint-disable-next-line @typescript-eslint/no-var-requires
void (require('./workload') as typeof import('./workload')).runWorkload();
