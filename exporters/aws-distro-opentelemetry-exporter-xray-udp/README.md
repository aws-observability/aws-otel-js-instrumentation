# AWS Distro for OpenTelemetry (ADOT) X-Ray UDP Exporter

The AWS X-Ray UDP Exporter allows you to send OpenTelemetry Spans to the AWS X-Ray Daemon endpoint.
Notably, this will work with the X-Ray Daemon that runs in an AWS Lambda Environment.

## Installation

Install this package into your NodeJS project with:

```shell
npm install --save @aws/aws-distro-opentelemetry-exporter-xray-udp
```

## Usage

```js
const { AwsXrayUdpSpanExporter } = require("@aws/aws-distro-opentelemetry-exporter-xray-udp")
// ...

const _traceExporter = new AwsXrayUdpSpanExporter();
const _spanProcessor = new SimpleSpanProcessor(_traceExporter);

const sdk = new opentelemetry.NodeSDK({
    spanProcessor: _spanProcessor,
    // ...
});
```
