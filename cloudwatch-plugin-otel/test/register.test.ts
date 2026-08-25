// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import Module = require('module');

// register.ts is loaded via --require, frequently process-wide through NODE_OPTIONS, so a load-time
// exception would abort every Node process on the host — including ones with no OpenTelemetry
// installed at all (none of the OTel packages are regular dependencies of this package, so
// consumers do not necessarily have any of them). The module must degrade to a warning, never a
// crash — whichever package is missing, including @opentelemetry/api itself (which everything else,
// diag included, lives in).
describe('register (load-time fail-safe)', () => {
  const REGISTER_PATH = require.resolve('../src/register');

  // Requires register fresh while hiding every module whose request matches one of `hiddenPrefixes`
  // (resolution throws MODULE_NOT_FOUND, the way a host without those packages behaves).
  function requireRegisterWithHidden(hiddenPrefixes: string[]): { threw: unknown; stderr: string } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const moduleAny = Module as any;
    const originalResolve = moduleAny._resolveFilename;
    moduleAny._resolveFilename = function (request: string, ...args: unknown[]) {
      if (hiddenPrefixes.some(prefix => request.startsWith(prefix))) {
        const err: NodeJS.ErrnoException = new Error(`Cannot find module '${request}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return originalResolve.call(this, request, ...args);
    };

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    // Capture WITHOUT forwarding: the fail-safe banner from this passing test would otherwise be
    // printed into every suite run and read like a real failure.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    delete require.cache[REGISTER_PATH];
    let threw: unknown;
    try {
      require(REGISTER_PATH);
    } catch (e) {
      threw = e;
    } finally {
      process.stderr.write = originalWrite;
      moduleAny._resolveFilename = originalResolve;
      delete require.cache[REGISTER_PATH];
      // The lazy requires inside patch() may have freshly cached local modules under the hook;
      // leave them — they resolve identically without it. Nothing to restore beyond the above.
    }
    return { threw, stderr: stderrChunks.join('') };
  }

  // Mirrors src/register.ts's own sdk-node resolution: it patches the copy reachable from
  // auto-instrumentations-node (the one upstream's zero-code register constructs), falling back to
  // plain resolution. That is not always the copy a bare require() from this test resolves — npm may
  // hoist auto-instrumentations-node to a level where it sees a different physical sdk-node of the
  // same version, in which case a test asserting on its own copy would silently exercise the
  // UNPATCHED NodeSDK. Resolve it the way register does so assertions target what it patched.
  function resolveSdkNodeAsRegisterDoes(): string {
    try {
      const autoInstrEntry = require.resolve('@opentelemetry/auto-instrumentations-node');
      return require.resolve('@opentelemetry/sdk-node', { paths: [autoInstrEntry] });
    } catch {
      return require.resolve('@opentelemetry/sdk-node');
    }
  }

  // F8 regression: with trace export disabled (OTEL_TRACES_EXPORTER=none) upstream NodeSDK
  // registers NO tracer provider — spans are non-recording and NO sampled traceparent is injected
  // into outgoing requests. The patched SDK must preserve that exactly: injecting our processor
  // would create a recording provider and flip downstream sampling decisions fleet-wide.
  it('F8: with OTEL_TRACES_EXPORTER=none the patched SDK registers no tracer provider and injects no traceparent', async function () {
    this.timeout(10000);
    /* eslint-disable @typescript-eslint/no-var-requires */
    const api = require('@opentelemetry/api');
    const sdkNode = require(resolveSdkNodeAsRegisterDoes());
    /* eslint-enable @typescript-eslint/no-var-requires */
    const originalDescriptor = Object.getOwnPropertyDescriptor(sdkNode, 'NodeSDK');
    const prevTraces = process.env.OTEL_TRACES_EXPORTER;
    const prevMetrics = process.env.OTEL_METRICS_EXPORTER;
    process.env.OTEL_TRACES_EXPORTER = 'none';
    process.env.OTEL_METRICS_EXPORTER = 'none';
    delete require.cache[REGISTER_PATH];
    let sdk: any;
    try {
      require(REGISTER_PATH); // patches the NodeSDK export in the module cache
      const PatchedNodeSDK = sdkNode.NodeSDK;

      // Capture every diag message: after the DISABLED warning the extension must stay silent —
      // in particular no "[span-metrics] active" info (the self-verify's introspection defaults
      // would otherwise claim active right after the abort).
      const logs: string[] = [];
      const capture = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
        return true;
      };
      api.diag.setLogger(
        { error: capture, warn: capture, info: capture, debug: capture, verbose: capture },
        api.DiagLogLevel.ALL
      );

      sdk = new PatchedNodeSDK({});
      sdk.start();

      const spanMetricsLogs = logs.filter(m => m.includes('[span-metrics]'));
      assert.ok(
        spanMetricsLogs.some(m => m.includes('trace export is disabled')),
        `the DISABLED warning must fire; got: ${JSON.stringify(spanMetricsLogs)}`
      );
      assert.ok(
        !spanMetricsLogs.some(m => m.includes('active')),
        `no "active" claim may follow an abort; got: ${JSON.stringify(spanMetricsLogs)}`
      );
      assert.ok(
        !spanMetricsLogs.some(m => m.includes('does not appear to be attached')),
        `no misleading attach warning after a deliberate abort; got: ${JSON.stringify(spanMetricsLogs)}`
      );

      // No global tracer provider: tracers are non-recording, exactly like unpatched upstream.
      const span = api.trace.getTracer('f8-probe').startSpan('probe');
      assert.strictEqual(span.isRecording(), false, 'spans must be non-recording with export disabled');
      span.end();

      // No sampled trace context is injected into carriers (the original finding: a recording
      // provider here caused traceparent headers ending in -01 on every outgoing request).
      const carrier: Record<string, string> = {};
      api.context.with(api.trace.setSpan(api.context.active(), span), () => {
        api.propagation.inject(api.context.active(), carrier);
      });
      assert.ok(
        !('traceparent' in carrier) || !carrier.traceparent.endsWith('-01'),
        `no sampled traceparent may be injected; got ${JSON.stringify(carrier)}`
      );
    } finally {
      if (sdk) {
        await sdk.shutdown().catch(() => {});
      }
      if (originalDescriptor) {
        Object.defineProperty(sdkNode, 'NodeSDK', originalDescriptor);
      }
      delete require.cache[REGISTER_PATH];
      if (prevTraces === undefined) delete process.env.OTEL_TRACES_EXPORTER;
      else process.env.OTEL_TRACES_EXPORTER = prevTraces;
      if (prevMetrics === undefined) delete process.env.OTEL_METRICS_EXPORTER;
      else process.env.OTEL_METRICS_EXPORTER = prevMetrics;
      // Reset API globals the SDK may have registered during start().
      api.trace.disable();
      api.context.disable();
      api.propagation.disable();
      api.metrics.disable();
      api.diag.disable();
    }
  });

  it('does not throw when @opentelemetry/sdk-node cannot be resolved, and surfaces a stderr notice', () => {
    const { threw, stderr } = requireRegisterWithHidden([
      '@opentelemetry/sdk-node',
      '@opentelemetry/auto-instrumentations-node',
    ]);
    assert.strictEqual(threw, undefined, `register must never crash the host at load; threw: ${threw}`);
    assert.ok(
      stderr.includes('span metrics are DISABLED'),
      `expected a visible stderr notice (diag is not yet wired at --require time); got: ${JSON.stringify(stderr)}`
    );
  });

  it('does not throw when even @opentelemetry/api is missing (diag itself unavailable)', () => {
    // F1: the crash guard must also cover its own error reporting — diag lives in the api package,
    // so the catch handler cannot assume it resolves. stderr is the unconditional channel.
    const { threw, stderr } = requireRegisterWithHidden([
      '@opentelemetry/api',
      '@opentelemetry/sdk-node',
      '@opentelemetry/auto-instrumentations-node',
      '@opentelemetry/sdk-trace-base',
      '@opentelemetry/core',
    ]);
    assert.strictEqual(threw, undefined, `register must never crash the host at load; threw: ${threw}`);
    assert.ok(
      stderr.includes('span metrics are DISABLED'),
      `stderr notice must still surface: ${JSON.stringify(stderr)}`
    );
  });

  it('does not throw when @opentelemetry/sdk-trace-base is missing (sampler/processor deps)', () => {
    const { threw, stderr } = requireRegisterWithHidden([
      '@opentelemetry/sdk-trace-base',
      '@opentelemetry/sdk-node',
      '@opentelemetry/auto-instrumentations-node',
    ]);
    assert.strictEqual(threw, undefined, `register must never crash the host at load; threw: ${threw}`);
    assert.ok(
      stderr.includes('span metrics are DISABLED'),
      `stderr notice must still surface: ${JSON.stringify(stderr)}`
    );
  });
});
