// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import { BreakpointManager } from '../../src/dynamic-instrumentation/breakpoint-manager';
import { InspectorSession, SetBreakpointResult } from '../../src/dynamic-instrumentation/session';
import { FileResolver, ResolvedScript } from '../../src/dynamic-instrumentation/file-resolver';
import { InstrumentationConfiguration } from '../../src/dynamic-instrumentation/model/instrumentation-configuration';
import { InstrumentationType, ErrorCause } from '../../src/dynamic-instrumentation/model/types';
import { CAPTURE_DEFAULTS } from '../../src/dynamic-instrumentation/model/capture-configuration';

/**
 * Tests BreakpointManager.addBreakpoint handling of V8 breakpoint resolution.
 * V8 may bind a breakpoint to the nearest executable location, sliding it forward
 * from a function-declaration / blank / comment line — this is normal and the
 * breakpoint is kept. Only a complete failure to bind (no resolved location)
 * reports LINE_NOT_EXECUTABLE.
 */
describe('BreakpointManager breakpoint resolution', function () {
  let mockSession: sinon.SinonStubbedInstance<InspectorSession>;
  let mockFileResolver: sinon.SinonStubbedInstance<FileResolver>;
  let manager: BreakpointManager;
  let errors: Array<{ locationHash: string; cause: ErrorCause }>;

  // A plain (non-source-mapped) JS resolution. targetLine = config.lineNumber - 1.
  const RESOLVED: ResolvedScript = {
    scriptId: 'script-1',
    url: 'file:///app/orders.js',
  };

  function makeConfig(lineNumber: number): InstrumentationConfiguration {
    return {
      codeUnit: '',
      className: '',
      methodName: '',
      lineNumber,
      filePath: 'orders.js',
      captureConfig: { ...CAPTURE_DEFAULTS },
      locationHash: 'hash-1',
      instrumentationType: InstrumentationType.BREAKPOINT,
      instrumentationName: 'bp',
      expiresAt: null,
      maxHits: 100,
      attributeFilters: [],
      arn: '',
      createdAt: null,
      signalType: 'SNAPSHOT',
    } as InstrumentationConfiguration;
  }

  beforeEach(function () {
    mockSession = sinon.createStubInstance(InspectorSession);
    mockFileResolver = sinon.createStubInstance(FileResolver);
    // BreakpointManager reads its own fileResolver field, not the session's.
    manager = new BreakpointManager(
      mockSession as unknown as InspectorSession,
      mockFileResolver as unknown as FileResolver
    );

    errors = [];
    manager.setErrorCallback((_type, locationHash, cause) => {
      errors.push({ locationHash, cause });
    });

    mockFileResolver.resolve.returns(RESOLVED);
    mockSession.removeBreakpointAsync.resolves();
  });

  afterEach(function () {
    sinon.restore();
  });

  it('installs the breakpoint when V8 binds it to the requested line', async function () {
    // config.lineNumber=42 → targetLine=41 (0-based). V8 resolves to the same line.
    const result: SetBreakpointResult = { breakpointId: 'bp-1', resolvedLine: 41 };
    mockSession.setBreakpointAsync.resolves(result);

    const ok = await manager.addBreakpoint(makeConfig(42));

    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(mockSession.removeBreakpointAsync.called).toBe(false);
    expect(manager.getRegistryKeyByV8Id('bp-1')).toBeDefined();
  });

  it('treats a column-only adjustment on the same line as a normal install', async function () {
    // Same resolved line (41), V8 may have shifted the column — still the requested line.
    mockSession.setBreakpointAsync.resolves({ breakpointId: 'bp-2', resolvedLine: 41 });

    const ok = await manager.addBreakpoint(makeConfig(42));

    expect(ok).toBe(true);
    expect(errors).toEqual([]);
  });

  it('keeps the breakpoint when V8 slides it forward to the nearest executable line', async function () {
    // Requested targetLine=41 (user line 42, a function-declaration line). V8 binds to
    // line 43 (0-based) — the first executable statement. This forward slide is normal;
    // the breakpoint must be kept and not reported as an error.
    mockSession.setBreakpointAsync.resolves({ breakpointId: 'bp-3', resolvedLine: 43 });

    const ok = await manager.addBreakpoint(makeConfig(42));

    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(mockSession.removeBreakpointAsync.called).toBe(false);
    expect(manager.getRegistryKeyByV8Id('bp-3')).toBeDefined();
  });

  it('reports LINE_NOT_EXECUTABLE when V8 binds no location (resolvedLine null)', async function () {
    mockSession.setBreakpointAsync.resolves({ breakpointId: 'bp-4', resolvedLine: null });

    const ok = await manager.addBreakpoint(makeConfig(42));

    expect(ok).toBe(false);
    expect(errors).toEqual([{ locationHash: 'hash-1', cause: ErrorCause.LINE_NOT_EXECUTABLE }]);
    expect(mockSession.removeBreakpointAsync.calledOnceWith('bp-4')).toBe(true);
  });

  it('reports RUNTIME_ERROR when the V8 set call fails entirely', async function () {
    mockSession.setBreakpointAsync.resolves(null);

    const ok = await manager.addBreakpoint(makeConfig(42));

    expect(ok).toBe(false);
    expect(errors).toEqual([{ locationHash: 'hash-1', cause: ErrorCause.RUNTIME_ERROR }]);
    expect(mockSession.removeBreakpointAsync.called).toBe(false);
  });

  it('compares against the source-map-resolved line, not the user line', async function () {
    // Source-map resolution: user line 10 (1-based) maps to compiled line 99 (0-based).
    mockFileResolver.resolve.returns({
      scriptId: 'script-1',
      url: 'file:///app/dist/orders.js',
      resolvedLine: 99,
      sourceMapResolved: true,
    });
    // V8 binds exactly at the resolved compiled line → install, no slide.
    mockSession.setBreakpointAsync.resolves({ breakpointId: 'bp-5', resolvedLine: 99 });

    const ok = await manager.addBreakpoint(makeConfig(10));

    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(mockSession.setBreakpointAsync.calledOnce).toBe(true);
    // targetLine passed to V8 must be the resolved compiled line (99), not 9.
    expect(mockSession.setBreakpointAsync.firstCall.args[1]).toBe(99);
  });
});
