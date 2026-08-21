// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// DB-family contract app: a plain app (no OTel code) whose only work is real Postgres queries via
// `pg`, so the pg instrumentation produces real DB CLIENT spans. Instrumentation is injected by the
// --require chain (zero-code mode). Connection is env-configured by the test. Runs a fixed number of
// queries, then exits after a flush delay.
export async function runDbWorkload(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg');

  const client = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
  await client.connect();
  await client.query('CREATE TABLE IF NOT EXISTS test_items (id INT)');

  const QUERY_COUNT = 30;
  for (let i = 0; i < QUERY_COUNT; i++) {
    await client.query('SELECT id FROM test_items');
  }

  await client.end();
  // allow batch span export + metric export interval to flush before exit
  await new Promise(resolve => setTimeout(resolve, 4000));
  process.exit(0);
}

void runDbWorkload();
