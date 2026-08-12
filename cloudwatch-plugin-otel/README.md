# CloudWatch Plugin for OpenTelemetry — Span Metrics (Node.js)

> npm package: `@aws/cloudwatch-plugin-otel`

Generates span-derived RED metrics (**rate, errors, duration**) inside the OpenTelemetry JS SDK,
from **100% of spans**, before trace sampling takes effect. This solves the undercount you get when
metrics are derived downstream (e.g. the Collector's spanmetrics connector) from an already-sampled
trace stream: at 5% sampling, downstream RED metrics reflect ~5% of real traffic, while this
extension reflects all of it.

It produces two metrics matching the SpanMetricsConnector schema:

- `traces.span.metrics.calls` — Counter (monotonic sum), unit unset
- `traces.span.metrics.duration` — Histogram, unit `s` (seconds), SpanMetricsConnector default buckets

with base dimensions `service.name`, `span.name`, `span.kind` (short form), `status.code` (short
form), plus an allowlisted subset of semantic-convention attributes per span.

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
| **Programmatic (`withSpanMetrics`)** | apps with a `NodeSDK` bootstrap file | wrap the NodeSDK config; **recommended** |
| **Manual** | apps that hand-build `TracerProvider` | add the processor + sampler + `bind()` directly |
| **Zero-code (`/register`)** | apps using `auto-instrumentations-node/register` | add one `--require` before it |

### Programmatic (recommended)

```js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { withSpanMetrics, bind } = require('@aws/cloudwatch-plugin-otel');

// The extension records into a MeterProvider you own; construct and bind it.
const meterProvider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
});
bind(meterProvider);

const sdk = new NodeSDK(withSpanMetrics({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
}));
sdk.start();
```

`withSpanMetrics(config)` wraps your sampler (if set), appends the span processor, and — if you
configured only `traceExporter` — converts it into a `BatchSpanProcessor` so your span export is
preserved (NodeSDK ignores `traceExporter` once `spanProcessors` is set). The deprecated singular
`spanProcessor` option is not supported (a warning is logged and it is ignored).

### Manual

```js
const { TracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const { SpanMetricsProcessor, AlwaysRecordSampler, bind } = require('@aws/cloudwatch-plugin-otel');

bind(meterProvider); // your MeterProvider

const tracerProvider = new TracerProvider({
  sampler: AlwaysRecordSampler.create(mySampler),
  spanProcessors: [new SpanMetricsProcessor(), new BatchSpanProcessor(myExporter)],
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
end-to-end** (all modes, real instrumentation → OTLP → collector). A nightly
`Span Metrics Extension - Compatibility` workflow re-runs them against the latest published
OpenTelemetry packages so drift shows up as a red run.

All three modes are verified end-to-end across the full range **`@opentelemetry/sdk-node` 0.203 →
0.221** (with matching `auto-instrumentations-node` 0.60 → 0.79, `sdk-trace-base`/`sdk-metrics`
2.7 → 2.10, `api` ^1.9). This spans both NodeSDK internal layouts (the pre-0.220 instance-field shape
and the 0.220+ `start()`-local shape).

| OpenTelemetry packages | Programmatic & Manual | Zero-code (`/register`) |
|---|---|---|
| `sdk-node` 0.203–0.219 (+ matching `auto-instrumentations-node`, `sdk-trace-base`/`sdk-metrics` 2.7–2.9) | ✅ Verified | ✅ Verified |
| `sdk-node` 0.220–0.221 (+ `auto-instrumentations-node` 0.78–0.79, `sdk-trace-base`/`sdk-metrics` 2.10) | ✅ Verified | ✅ Verified |

**Guidance:**

- **Programmatic and Manual modes** use only public OpenTelemetry SDK API. Peer requirement:
  `@opentelemetry/api` `^1.9.0` and `@opentelemetry/sdk-trace-base` `^2.0.0`.
- **Zero-code mode** patches non-public `NodeSDK` internals, so it does not rely on a version number.
  At startup it **detects the NodeSDK internal layout** (the two known shapes above) to choose how to
  inject, and **after `start()` verifies the extension actually took effect** (processor attached +
  MeterProvider bound). If it encounters an unrecognized layout, or the self-check shows the extension
  is inert, it **fails safe** — it disables itself and logs a warning rather than mis-wiring your
  pipeline; traces and metrics continue with upstream behavior. This self-adapts to new `sdk-node`
  releases that keep a known shape, without a version-allowlist bump. The nightly
  compatibility workflow re-verifies against the latest release so any genuine drift surfaces early.

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
