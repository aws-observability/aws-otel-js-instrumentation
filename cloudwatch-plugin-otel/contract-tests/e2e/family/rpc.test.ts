// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// RPC family (analog of Java's RpcFamilyTest): verifies the RPC semconv attributes the extension
// copies onto span metrics, driven by REAL grpc instrumentation against an in-process gRPC server.
// No container is needed — gRPC runs in-process — so this test does not require Docker.
import * as assert from 'assert';
import * as path from 'path';
import { MockCollector } from '../utils/mock-collector';
import { runApp } from '../utils/run-app';

const OUR_REGISTER = path.resolve(__dirname, '..', '..', '..', 'build', 'src', 'register.js');
const UPSTREAM_REGISTER = '@opentelemetry/auto-instrumentations-node/register';
const COLLECTOR_PORT = 4331;
const COLLECTOR_ENDPOINT = `http://localhost:${COLLECTOR_PORT}`;

// grpc names the span "grpc.<service>/<method>".
const RPC_SPAN_NAME = 'grpc.contract.Echoer/Echo';

describe('Contract: RPC attributes family (gRPC)', function () {
  this.timeout(90000);
  let collector: MockCollector;

  before(async function () {
    this.timeout(60000);
    collector = new MockCollector();
    await collector.start(COLLECTOR_PORT);
    await runApp({
      app: 'rpc-app',
      requires: [OUR_REGISTER, UPSTREAM_REGISTER],
      appPort: 8170, // unused by rpc-app but required by the runner
      collectorEndpoint: COLLECTOR_ENDPOINT,
      builtJs: true,
      env: {
        RPC_PORT: '50253',
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
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'grpc',
        OTEL_SERVICE_NAME: 'contract-rpc',
      },
    });
  });

  after(async () => collector.stop());

  it('meters RPC spans with rpc.system/service/method', () => {
    const attrs = collector.callsAttributes(RPC_SPAN_NAME);
    assert.ok(attrs, `calls datapoint for "${RPC_SPAN_NAME}" present`);
    assert.strictEqual(attrs!['rpc.system'], 'grpc');
    assert.strictEqual(attrs!['rpc.service'], 'contract.Echoer');
    assert.strictEqual(attrs!['rpc.method'], 'Echo');
  });

  // Peer attributes on the client span. server.address is copied as a string dimension; the gRPC
  // client span reliably carries it (derived from the channel target), so this is the end-to-end
  // check for the peer family. The remaining new families (GenAI, FaaS, and the AWS resource-identity
  // keys) are exercised by the pure unit tests instead, because real instrumentation cannot produce
  // those spans in this harness.
  it('copies the peer host from the gRPC client span', () => {
    const clientAttrs = collector.findCallsAttributes(RPC_SPAN_NAME, a => a['span.kind'] === 'CLIENT');
    assert.ok(clientAttrs, `CLIENT calls datapoint for "${RPC_SPAN_NAME}" present`);
    // Current instrumentation emits server.address; older field-floor instrumentation emits the legacy
    // net.peer.name pass-through. Accept whichever the installed version produced.
    const peerKey = 'server.address' in clientAttrs! ? 'server.address' : 'net.peer.name';
    assert.ok(peerKey in clientAttrs!, `peer host (server.address or net.peer.name) present for "${RPC_SPAN_NAME}"`);
    assert.strictEqual(clientAttrs![peerKey], 'localhost');
  });
});
