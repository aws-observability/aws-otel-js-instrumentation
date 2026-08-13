// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Mode 3 (manual): hand-built NodeTracerProvider + MeterProvider, wiring the extension explicitly.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { AlwaysRecordSampler, SpanMetricsProcessor, bind } from '../../src';

const endpoint = process.env.COLLECTOR_ENDPOINT ?? 'http://localhost:4319';
const resource = resourceFromAttributes({ 'service.name': 'contract-manual' });

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

const tracerProvider = new NodeTracerProvider({
  resource,
  sampler: AlwaysRecordSampler.create(new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.5) })),
  spanProcessors: [
    new SpanMetricsProcessor(),
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }), {
      scheduledDelayMillis: 500,
    }),
  ],
});
tracerProvider.register();
registerInstrumentations({ instrumentations: [getNodeAutoInstrumentations()], tracerProvider });

// Require the workload only AFTER http instrumentation is registered, so the `http` module is
// patched before the workload loads it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
void (require('./workload') as typeof import('./workload')).runWorkload();
