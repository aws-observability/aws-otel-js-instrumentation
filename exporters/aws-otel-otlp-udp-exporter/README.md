# AWS Distro for OpenTelemetry (ADOT) OTLP UDP Exporter

Install this package into your NodeJS project with:

```shell
npm install --save @aws/aws-otel-otlp-udp-exporter
```

## Usage

```js
import { OTLPUdpSpanExporter } from './otlp-udp-exporter';
import { SpanExporter } from '@opentelemetry/sdk-trace-base';

// ...

let otlpUdpSpanExporter: SpanExporter = new OTLPUdpSpanExporter('127.0.0.1:2000');
```
