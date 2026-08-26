// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Messaging family (analog of Java's MessagingFamilyTest): verifies the messaging semconv attributes
// the extension copies onto span metrics, driven by REAL kafkajs instrumentation against a real
// Kafka broker (testcontainers).
import * as assert from 'assert';
import * as path from 'path';
import { MockCollector } from '../utils/mock-collector';
import { runApp } from '../utils/run-app';
import { dockerAvailable, startKafka, StartedBackend } from '../utils/containers';

const OUR_REGISTER = path.resolve(__dirname, '..', '..', '..', 'build', 'src', 'register.js');
const UPSTREAM_REGISTER = '@opentelemetry/auto-instrumentations-node/register';
const COLLECTOR_PORT = 4332;
const COLLECTOR_ENDPOINT = `http://localhost:${COLLECTOR_PORT}`;

// kafkajs names the producer span "send <topic>".
const SEND_SPAN_NAME = 'send contract-topic';

describe('Contract: messaging attributes family (Kafka + kafkajs)', function () {
  this.timeout(300000);
  let collector: MockCollector;
  let kafka: StartedBackend | undefined;
  let ran = false;

  before(async function () {
    this.timeout(300000);
    if (!(await dockerAvailable())) {
      // eslint-disable-next-line no-console
      console.warn('[messaging.test] Docker not available; skipping messaging family contract test.');
      this.skip();
    }
    kafka = await startKafka();
    collector = new MockCollector();
    await collector.start(COLLECTOR_PORT);
    await runApp({
      app: 'messaging-app',
      requires: [OUR_REGISTER, UPSTREAM_REGISTER],
      appPort: 8180, // unused by messaging-app but required by the runner
      collectorEndpoint: COLLECTOR_ENDPOINT,
      builtJs: true,
      env: {
        KAFKA_HOST: kafka.host,
        KAFKA_PORT: String(kafka.port),
        OTEL_TRACES_SAMPLER: 'always_on',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR_ENDPOINT,
        OTEL_METRIC_EXPORT_INTERVAL: '1000',
        OTEL_METRIC_EXPORT_TIMEOUT: '500',
        OTEL_NODE_EXPERIMENTAL_SDK_METRICS: 'true',
        OTEL_NODE_RESOURCE_DETECTORS: 'env',
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'kafkajs',
        OTEL_SERVICE_NAME: 'contract-messaging',
      },
    });
    ran = true;
  });

  after(async () => {
    if (collector) await collector.stop();
    if (kafka) await kafka.container.stop();
  });

  it('meters producer spans with messaging.system/operation.name/destination.name', () => {
    if (!ran) return;
    const attrs = collector.callsAttributes(SEND_SPAN_NAME);
    assert.ok(attrs, `calls datapoint for "${SEND_SPAN_NAME}" present`);
    assert.strictEqual(attrs!['span.kind'], 'PRODUCER');
    assert.strictEqual(attrs!['messaging.system'], 'kafka');
    assert.strictEqual(attrs!['messaging.operation.name'], 'send');
    assert.strictEqual(attrs!['messaging.destination.name'], 'contract-topic');
  });
});
