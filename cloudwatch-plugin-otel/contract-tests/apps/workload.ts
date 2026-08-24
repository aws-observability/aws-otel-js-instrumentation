// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared workload for the contract-test apps. Runs an Express server with a routed endpoint so the
// instrumentation produces a templated SERVER span name and http.route (GET /items/:id), then
// self-drives REQUEST_COUNT requests and exits. Express + HTTP are auto-instrumented with no
// external services (Docker-free). DB/RPC/messaging attribute derivation is covered by the
// attributes-builder unit tests; live coverage for those families needs real backends (deferred).

export const REQUEST_COUNT = 60;
// Express instrumentation names the server span by method + route template.
export const SERVER_SPAN_NAME = 'GET /items/:id';

export async function runWorkload(): Promise<void> {
  // Required lazily by the app AFTER instrumentation is installed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http');
  const port = Number(process.env.APP_PORT ?? 8110);

  const app = express();
  app.get('/items/:id', (_req: unknown, res: { end: (s: string) => void }) => res.end('ok'));
  const server = await new Promise<any>(resolve => {
    const s = app.listen(port, () => resolve(s));
  });

  const drivePath = process.env.DRIVE_PATH ?? '/items/42';
  for (let i = 0; i < REQUEST_COUNT; i++) {
    await new Promise<void>(resolve => {
      const req = http.get(`http://localhost:${port}${drivePath}`, (r: any) => r.resume().on('end', () => resolve()));
      req.on('error', () => resolve());
    });
  }
  // Give batch span export + metric export interval time to flush before exit.
  await new Promise(resolve => setTimeout(resolve, 4000));
  server.close();
  process.exit(0);
}
