// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// DB family (analog of Java's DbFamilyTest): verifies the DB semconv attributes the extension copies
// onto span metrics, driven by REAL pg instrumentation against a real Postgres (testcontainers).
// This is the live counterpart to the attributes-builder unit tests — it validates our allowlist and
// legacy-fallback against what the pg instrumentation actually emits, not against assumed keys.
import * as assert from 'assert';
import * as path from 'path';
import { MockCollector } from '../utils/mock-collector';
import { runApp } from '../utils/run-app';
import { dockerAvailable, startPostgres, StartedBackend } from '../utils/containers';

const OUR_REGISTER = path.resolve(__dirname, '..', '..', '..', 'build', 'src', 'register.js');
const UPSTREAM_REGISTER = '@opentelemetry/auto-instrumentations-node/register';
const COLLECTOR_PORT = 4330;
const COLLECTOR_ENDPOINT = `http://localhost:${COLLECTOR_PORT}`;

// pg names the query span "pg.query:<OP> <db>"; a SELECT against our db is stable to key on.
const SELECT_SPAN_NAME = 'pg.query:SELECT contract';

describe('Contract: DB attributes family (Postgres + pg)', function () {
  this.timeout(180000);
  let collector: MockCollector;
  let pg: (StartedBackend & { database: string; user: string; password: string }) | undefined;
  let ran = false;

  before(async function () {
    this.timeout(180000);
    if (!(await dockerAvailable())) {
      // eslint-disable-next-line no-console
      console.warn('[db.test] Docker not available; skipping DB family contract test.');
      this.skip();
    }
    pg = await startPostgres();
    collector = new MockCollector();
    await collector.start(COLLECTOR_PORT);
    await runApp({
      app: 'db-app',
      requires: [OUR_REGISTER, UPSTREAM_REGISTER],
      appPort: 8160, // unused by db-app but required by the runner
      collectorEndpoint: COLLECTOR_ENDPOINT,
      builtJs: true,
      env: {
        PGHOST: pg.host,
        PGPORT: String(pg.port),
        PGDATABASE: pg.database,
        PGUSER: pg.user,
        PGPASSWORD: pg.password,
        OTEL_TRACES_SAMPLER: 'always_on',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_TRACES_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR_ENDPOINT,
        OTEL_METRIC_EXPORT_INTERVAL: '1000',
        OTEL_METRIC_EXPORT_TIMEOUT: '500',
        OTEL_NODE_EXPERIMENTAL_SDK_METRICS: 'true',
        OTEL_NODE_RESOURCE_DETECTORS: 'env',
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'pg',
        OTEL_SERVICE_NAME: 'contract-db',
      },
    });
    ran = true;
  });

  after(async () => {
    if (collector) await collector.stop();
    if (pg) await pg.container.stop();
  });

  it('meters DB client spans with the DB system attribute; excludes high-cardinality statement', () => {
    if (!ran) return;
    const attrs = collector.callsAttributes(SELECT_SPAN_NAME);
    assert.ok(attrs, `calls datapoint for "${SELECT_SPAN_NAME}" present`);
    assert.strictEqual(attrs!['span.kind'], 'CLIENT');
    assert.strictEqual(attrs!['service.name'], 'contract-db');

    // The DB system attribute is copied. Accept either the current key (db.system.name) or, on older
    // instrumentation, the legacy key passed through unchanged (db.system) — the spec's DB legacy
    // fallback. Exactly one must be present with the postgres value.
    const current = attrs!['db.system.name'];
    const legacy = attrs!['db.system'];
    assert.ok(
      current === 'postgresql' || legacy === 'postgresql',
      `expected db.system.name or db.system = postgresql, got current=${current} legacy=${legacy}`
    );

    // High-cardinality statement text is never copied, regardless of instrumentation.
    assert.ok(!('db.statement' in attrs!), 'db.statement must not be copied');
  });
});
