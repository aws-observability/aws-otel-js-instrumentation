// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as fs from 'fs';
import * as path from 'path';
import { trace, ROOT_CONTEXT, Span } from '@opentelemetry/api';
import { TRACE_CONTEXT_EXPRESSION } from '../../src/dynamic-instrumentation/snapshot-collector';

// Read the installed @opentelemetry/api version from its package.json. The package
// does not export './package.json' as a subpath, so resolve the module entry point
// and walk up to the package root.
function installedApiVersion(): string {
  const entry = require.resolve('@opentelemetry/api');
  let dir = path.dirname(entry);
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name === '@opentelemetry/api') {
        return pkg.version;
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate @opentelemetry/api package.json');
}

/**
 * Guards the hardcoded symbols in TRACE_CONTEXT_EXPRESSION against drift from the
 * installed @opentelemetry/api version.
 *
 * The expression is evaluated on the paused main thread and accesses OTel's global
 * API registration via Symbol.for('opentelemetry.js.api.<major>') and the active
 * span via Symbol.for('OpenTelemetry Context Key SPAN'). Neither symbol is part of
 * the public API surface, so an @opentelemetry/api major version bump would silently
 * break trace correlation (empty traceId/spanId) without these tests.
 *
 * IMPORTANT: these tests must not mutate any process-global OTel state (e.g. the
 * global context manager). Other test suites in this package rely on the context
 * manager registered by auto-instrumentation; disabling or replacing it here would
 * break their context propagation when run in the same mocha process.
 */
describe('TRACE_CONTEXT_EXPRESSION symbol compatibility', function () {
  const apiSymbolMatch = TRACE_CONTEXT_EXPRESSION.match(/Symbol\.for\('(opentelemetry\.js\.api\.\d+)'\)/);
  const spanKeyMatch = TRACE_CONTEXT_EXPRESSION.match(/Symbol\.for\('(OpenTelemetry Context Key SPAN)'\)/);

  it('should contain the global API registration symbol and the span context key', function () {
    expect(apiSymbolMatch).not.toBeNull();
    expect(spanKeyMatch).not.toBeNull();
  });

  it('should encode the installed @opentelemetry/api major version in the global registration symbol', function () {
    // The OTel JS API registers its global under Symbol.for('opentelemetry.js.api.<major>').
    // Derive the installed major from the package version and assert the expression's
    // hardcoded symbol matches, so a major bump fails here at test time.
    const apiVersion = installedApiVersion();
    const installedMajor = apiVersion.split('.')[0];

    const symbolVersion = apiSymbolMatch![1].split('.').pop();
    expect(symbolVersion).toBe(installedMajor);
  });

  it('should resolve a span set via the installed trace API through the expression span key', function () {
    // Build a context with an active span using only immutable helpers (no global
    // registration), then read it back through the exact symbol the expression uses.
    const spanContext = {
      traceId: 'abcdef1234567890abcdef1234567890',
      spanId: '1234567890abcdef',
      traceFlags: 1,
    };
    const ctx = trace.setSpanContext(ROOT_CONTEXT, spanContext);

    const span = ctx.getValue(Symbol.for(spanKeyMatch![1])) as Span | undefined;
    expect(span).toBeDefined();
    expect(span!.spanContext().traceId).toBe(spanContext.traceId);
    expect(span!.spanContext().spanId).toBe(spanContext.spanId);
  });
});
