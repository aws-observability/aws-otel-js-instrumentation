// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as os from 'os';
import * as path from 'path';
import { ServiceEventsInstrumentation } from '../../src/serviceevents/serviceevents-instrumentation';
import { createServiceEventsConfigFromEnv } from '../../src/serviceevents/config';

/**
 * Regression test for the ORR finding "No graceful flush on exit — SIGTERM handler
 * calls shutdown() fire-and-forget; queued telemetry lost on exit".
 *
 * ServiceEventsInstrumentation.shutdown() must be awaitable and resolve only after
 * the OTLP emitter has force-flushed + shut down, so the SIGTERM handler can await
 * the final flush rather than letting the process exit with buffered data.
 *
 * Uses file-export mode (OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE) so the test never
 * touches the network.
 */
describe('ServiceEventsInstrumentation.shutdown() awaitable flush', function () {
  let prevEnabled: string | undefined;
  let prevOutFile: string | undefined;

  beforeEach(function () {
    prevEnabled = process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED;
    prevOutFile = process.env.OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE;
    process.env.OTEL_AWS_SERVICE_EVENTS_ENABLED = 'true';
    process.env.OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE = path.join(os.tmpdir(), `se-shutdown-test-${process.pid}.ndjson`);
  });

  afterEach(function () {
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore('OTEL_AWS_SERVICE_EVENTS_ENABLED', prevEnabled);
    restore('OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE', prevOutFile);
  });

  it('shutdown() returns a promise that resolves (awaits the emitter flush)', async function () {
    const config = createServiceEventsConfigFromEnv();
    expect(config.enabled).toBe(true);

    const instr = new ServiceEventsInstrumentation(config);
    instr.initialize();
    expect(instr.isInitialized()).toBe(true);

    const result = instr.shutdown();
    // Must be a thenable (async), not void.
    expect(typeof (result as Promise<void>).then).toBe('function');
    await result;

    // Idempotent: a second shutdown is a no-op that still resolves.
    expect(instr.isInitialized()).toBe(false);
    await instr.shutdown();
  });

  it('shutdown() resolves even when never initialized', async function () {
    const config = createServiceEventsConfigFromEnv();
    const instr = new ServiceEventsInstrumentation(config);
    // No initialize() call.
    await instr.shutdown();
    expect(instr.isInitialized()).toBe(false);
  });
});
