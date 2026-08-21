# CloudWatch Plugin for OpenTelemetry — Span Metrics (Node.js)

> npm package: `@aws/cloudwatch-plugin-otel`

Generates span-derived RED metrics (**rate, errors, duration**) inside the OpenTelemetry JS SDK,
from **100% of spans**, before trace sampling takes effect. This solves the undercount you get when
metrics are derived downstream (e.g. the Collector's spanmetrics connector) from an already-sampled
trace stream: at 5% sampling, downstream RED metrics reflect ~5% of real traffic, while this
extension reflects all of it.

It produces two metrics matching the SpanMetricsConnector schema:

- `traces.span.metrics.calls` — Counter (monotonic sum), unit `{call}`
- `traces.span.metrics.duration` — Histogram, unit `s` (seconds), SpanMetricsConnector default buckets

with base dimensions `span.name`, `span.kind` (short form), `status.code` (short form), plus an
allowlisted subset of semantic-convention attributes per span. `service.name` is carried by the
metric's **resource** (the host SDK's resource), not duplicated on each datapoint.

## How it works

Two pieces:

1. **`SpanMetricsProcessor`** — a `SpanProcessor` that records the two metrics in `onEnd()` via the
   host SDK's `MeterProvider`.
2. **`AlwaysRecordSampler`** — wraps your configured sampler, turning `DROP` (NOT_RECORD) into
   `RECORD_ONLY` (RECORD). Unsampled spans are still recorded (so `onEnd()` sees them and meters
   them) but are not exported, so trace volume and cost stay at your configured sampling rate.

## Integration modes

| Mode | For | How |
|---|---|---|
| **Programmatic (`withSpanMetrics`)** | apps with a `NodeSDK` bootstrap file | wrap the NodeSDK config |
| **Manual** | apps that hand-build `TracerProvider` | add the processor + sampler + `bind()` directly |
| **Zero-code (`/register`)** | apps using `auto-instrumentations-node/register` | add one `--require` before it |

### Programmatic (`withSpanMetrics`)

```js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { withSpanMetrics } = require('@aws/cloudwatch-plugin-otel');

// Set OTEL_SERVICE_NAME (or `serviceName` / `resource` below) so metrics and traces share one
// resource. NodeSDK builds a MeterProvider from the metric reader and registers it globally; the
// extension records into that same provider automatically — no bind() call is needed in this mode.
const sdk = new NodeSDK(withSpanMetrics({
  traceExporter: new OTLPTraceExporter(),
  metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
  instrumentations: [getNodeAutoInstrumentations()],
}));
sdk.start();
```

`withSpanMetrics(config)` wraps your sampler (if set), appends the span processor, and — if you
configured only `traceExporter` — converts it into a `BatchSpanProcessor` so your span export is
preserved (NodeSDK ignores `traceExporter` once `spanProcessors` is set). The deprecated singular
`spanProcessor` option is honored with NodeSDK's own precedence (converted into `spanProcessors`,
with a deprecation warning) — please migrate to `spanProcessors`.

The extension records into the global `MeterProvider` that NodeSDK builds and registers. As long as
you configure a metric reader (via the config above or `OTEL_METRICS_EXPORTER`), no explicit `bind()`
is required — the metrics inherit the SDK's resource (your `service.name`). Call `bind(provider)`
only if you keep a `MeterProvider` you do **not** register globally.

### Manual

```js
const { NodeTracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const { ParentBasedSampler, TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-base');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
const { SpanMetricsProcessor, AlwaysRecordSampler, bind } = require('@aws/cloudwatch-plugin-otel');

// One resource shared by metrics and traces so both carry the same service.name.
const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'my-service' });

// Build and bind the MeterProvider the extension records into.
const meterProvider = new MeterProvider({
  resource,
  readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
});
bind(meterProvider);

// Wrap your sampler so unsampled spans are still recorded (and therefore metered), then register.
const tracerProvider = new NodeTracerProvider({
  resource,
  sampler: AlwaysRecordSampler.create(new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.05) })),
  spanProcessors: [new SpanMetricsProcessor(), new BatchSpanProcessor(new OTLPTraceExporter())],
});
tracerProvider.register();
```

### Zero-code

Load the extension's register hook **before** the upstream one:

```bash
node --require @aws/cloudwatch-plugin-otel/register \
     --require @opentelemetry/auto-instrumentations-node/register app.js
```

Your sampling config (`OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`) is honored and wrapped
automatically. If your metric export interval is short, ensure
`OTEL_METRIC_EXPORT_TIMEOUT` <= `OTEL_METRIC_EXPORT_INTERVAL` (an SDK constraint).

## Compatibility

The extension records only into your existing metrics pipeline (it adds a metric *source*, never a
new exporter or route) and keeps your sampling configuration unchanged.

The table below reflects results **verified by the extension's unit + contract suites run
end-to-end** (all modes, real instrumentation → OTLP → collector).

All three modes are verified end-to-end across the full range **`@opentelemetry/sdk-node` 0.203 →
0.221** (with matching `sdk-trace-base`/`sdk-metrics` 2.0 → 2.10 and `api` ^1.9). This spans both
NodeSDK internal layouts (the pre-0.220 instance-field shape and the 0.220+ `start()`-local shape).

| `@opentelemetry/sdk-node` | matching `sdk-trace-base` / `sdk-metrics` | Programmatic & Manual | Zero-code (`/register`) |
|---|---|---|---|
| 0.203 (FIELD-layout floor) | 2.0.1 | ✅ Verified | ✅ Verified |
| 0.219 (FIELD-layout ceiling) | 2.8.0 | ✅ Verified | ✅ Verified |
| 0.220 (CONFIG-layout floor) | 2.9.0 | ✅ Verified | ✅ Verified |
| 0.221 (CONFIG-layout ceiling) | 2.10.0 | ✅ Verified | ✅ Verified |

**Guidance:**

- **Programmatic and Manual modes** use only public OpenTelemetry SDK API. Peer requirement:
  `@opentelemetry/api` `^1.9.0` and `@opentelemetry/sdk-trace-base` `^2.0.0`.
- **Zero-code mode** patches non-public `NodeSDK` internals, so it does not rely on a version number.
  At startup it **detects the NodeSDK internal layout** (the two known shapes above) to choose how to
  inject, and **after `start()` verifies the extension actually took effect** (processor attached +
  MeterProvider bound). If it encounters an unrecognized layout, or the self-check shows the extension
  is inert, it **fails safe** — it disables itself and logs a warning rather than mis-wiring your
  pipeline; traces and metrics continue with upstream behavior. This self-adapts to new `sdk-node`
  releases that keep a known shape, without a version-allowlist bump.

## Development

```bash
npm run compile        # build src
npm test               # unit tests (builds first)
npm run test:contract  # contract tests: all modes, real bootstrap -> mock OTLP collector
npm run lint
```

Contract tests cover all integration modes plus per-family attribute derivation, driven through real
instrumentation to a mock OTLP collector:

- **Mode wiring** and the **base**, **HTTP**, and **RPC (gRPC, in-process)** families run Docker-free.
- The **DB (Postgres + `pg`)** and **messaging (Kafka + `kafkajs`)** families use
  [testcontainers](https://node.testcontainers.org/) to run against real backends, so they require a
  running Docker daemon. They **skip automatically** when Docker is unavailable, so the rest of the
  suite still runs without it.
