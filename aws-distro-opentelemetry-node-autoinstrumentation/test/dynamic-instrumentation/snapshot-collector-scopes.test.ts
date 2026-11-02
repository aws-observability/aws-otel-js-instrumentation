// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import * as inspector from 'inspector';
import { SnapshotCollector } from '../../src/dynamic-instrumentation/snapshot-collector';
import { InspectorSession } from '../../src/dynamic-instrumentation/session';
import { BreakpointManager } from '../../src/dynamic-instrumentation/breakpoint-manager';
import { InstrumentationRegistry } from '../../src/dynamic-instrumentation/registry/instrumentation-registry';
import { SnapshotOtlpEmitter } from '../../src/dynamic-instrumentation/snapshot-otlp-emitter';
import { DynamicInstrumentationConfig } from '../../src/dynamic-instrumentation/config';
import { CAPTURE_DEFAULTS, CaptureConfiguration } from '../../src/dynamic-instrumentation/model/capture-configuration';

/**
 * Verifies SnapshotCollector reads block-scoped variables (let/const inside
 * if/for/while bodies), not only the function-level 'local' scope, and that
 * inner block scopes shadow outer ones. V8 orders the scope chain innermost-first.
 */
describe('SnapshotCollector scope chain', function () {
  let collector: SnapshotCollector;
  let mockSession: sinon.SinonStubbedInstance<InspectorSession>;
  let mockBreakpointManager: sinon.SinonStubbedInstance<BreakpointManager>;
  let mockRegistry: sinon.SinonStubbedInstance<InstrumentationRegistry>;
  let mockEmitter: sinon.SinonStubbedInstance<SnapshotOtlpEmitter>;

  beforeEach(function () {
    mockSession = sinon.createStubInstance(InspectorSession);
    mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
    mockRegistry = sinon.createStubInstance(InstrumentationRegistry);
    mockEmitter = sinon.createStubInstance(SnapshotOtlpEmitter);

    const config: DynamicInstrumentationConfig = {
      enabled: true,
      serviceName: 'test-service',
      environment: 'test',
      apiUrl: 'http://localhost:4321',
      logsEndpoint: 'http://localhost:4321/v1/logs',
      probePollIntervalSeconds: 60,
      breakpointPollIntervalSeconds: 60,
      outputDirectory: '/tmp/test',
      resourceAttributes: {},
    };

    collector = new SnapshotCollector(
      mockSession as unknown as InspectorSession,
      mockBreakpointManager as unknown as BreakpointManager,
      mockRegistry as unknown as InstrumentationRegistry,
      mockEmitter as unknown as SnapshotOtlpEmitter,
      config
    );

    mockSession.resumeAsync.resolves();
    mockSession.evaluateOnCallFrameAsync.resolves(null);
    mockSession.getFileResolver.returns({ getScriptUrl: () => 'file:///app/test.js' } as any);
    mockSession.getSourceMapResolver.returns({
      buildNameMapping: () => null,
      reverseMap: () => null,
    } as any);
    mockBreakpointManager.getRegistryKeyByV8Id.returns('test-key');
    mockBreakpointManager.getResolvedScriptUrl.returns(undefined);
  });

  afterEach(function () {
    sinon.restore();
  });

  function registerConfig(captureOverrides: Partial<CaptureConfiguration>): void {
    mockRegistry.get.returns({
      config: {
        lineNumber: 11,
        filePath: 'test.js',
        locationHash: 'abc123',
        instrumentationType: 'BREAKPOINT',
        captureConfig: { ...CAPTURE_DEFAULTS, captureStackTrace: false, ...captureOverrides },
      },
      state: { recordHit: () => true },
    } as any);
  }

  /**
   * Build a paused event whose top frame has the given scope chain. Scope objects
   * are referenced by objectId so getPropertiesAsync can return their contents.
   */
  function buildPausedParams(
    scopeChain: Array<{ type: string; objectId: string }>
  ): inspector.Debugger.PausedEventDataType {
    return {
      callFrames: [
        {
          callFrameId: 'frame-1',
          functionName: 'testFunction',
          location: { scriptId: '1', lineNumber: 10 },
          url: 'file:///app/test.js',
          scopeChain: scopeChain.map(s => ({ type: s.type, object: { type: 'object', objectId: s.objectId } })),
          this: { type: 'object' },
        },
      ] as any[],
      reason: 'other',
      hitBreakpoints: ['bp-1'],
    } as inspector.Debugger.PausedEventDataType;
  }

  function str(value: string): inspector.Runtime.RemoteObject {
    return { type: 'string', value } as inspector.Runtime.RemoteObject;
  }

  function emittedLocals(): Record<string, any> {
    expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
    const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
    const lines = (snapshot.captures as any).lines;
    return lines[Object.keys(lines)[0]].locals;
  }

  it('captures variables from a block scope in addition to the local scope', async function () {
    // Chain (innermost-first): block { loopVar } then local { arg }.
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'block-1':
          return [{ name: 'loopVar', value: str('block-value') }] as any[];
        case 'local-1':
          return [{ name: 'arg', value: str('arg-value') }] as any[];
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: [] }); // capture all in-scope

    await collector.handlePaused(
      buildPausedParams([
        { type: 'block', objectId: 'block-1' },
        { type: 'local', objectId: 'local-1' },
      ])
    );

    const locals = emittedLocals();
    expect(locals.loopVar?.value).toBe('block-value');
    expect(locals.arg?.value).toBe('arg-value');
  });

  it('lets an inner block scope shadow an outer binding of the same name', async function () {
    // Both the inner block and the local scope declare `x`; inner must win.
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'block-1':
          return [{ name: 'x', value: str('inner') }] as any[];
        case 'local-1':
          return [{ name: 'x', value: str('outer') }] as any[];
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: [] });

    await collector.handlePaused(
      buildPausedParams([
        { type: 'block', objectId: 'block-1' },
        { type: 'local', objectId: 'local-1' },
      ])
    );

    expect(emittedLocals().x?.value).toBe('inner');
  });

  it('does not read scopes beyond the function local scope (closure/global)', async function () {
    // closure scope appears AFTER local in the chain — must not be captured.
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'local-1':
          return [{ name: 'local', value: str('yes') }] as any[];
        case 'closure-1':
          return [{ name: 'moduleVar', value: str('should-not-capture') }] as any[];
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: [] });

    await collector.handlePaused(
      buildPausedParams([
        { type: 'local', objectId: 'local-1' },
        { type: 'closure', objectId: 'closure-1' },
      ])
    );

    const locals = emittedLocals();
    expect(locals.local?.value).toBe('yes');
    expect(locals.moduleVar).toBeUndefined();
  });

  it('applies the CaptureLocals name filter across block and local scopes', async function () {
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'block-1':
          return [
            { name: 'wanted', value: str('keep') },
            { name: 'unwanted', value: str('drop') },
          ] as any[];
        case 'local-1':
          return [{ name: 'alsoUnwanted', value: str('drop') }] as any[];
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: ['wanted'] });

    await collector.handlePaused(
      buildPausedParams([
        { type: 'block', objectId: 'block-1' },
        { type: 'local', objectId: 'local-1' },
      ])
    );

    const locals = emittedLocals();
    expect(locals.wanted?.value).toBe('keep');
    expect(locals.unwanted).toBeUndefined();
    expect(locals.alsoUnwanted).toBeUndefined();
  });

  it('reads multiple nested block scopes preceding the local scope', async function () {
    // Chain (innermost-first): two block scopes then local. innerX shadows outerX.
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'block-inner':
          return [
            { name: 'innerOnly', value: str('inner') },
            { name: 'x', value: str('inner-x') },
          ] as any[];
        case 'block-outer':
          return [
            { name: 'outerOnly', value: str('outer') },
            { name: 'x', value: str('outer-x') },
          ] as any[];
        case 'local-1':
          return [{ name: 'arg', value: str('arg-value') }] as any[];
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: [] });

    await collector.handlePaused(
      buildPausedParams([
        { type: 'block', objectId: 'block-inner' },
        { type: 'block', objectId: 'block-outer' },
        { type: 'local', objectId: 'local-1' },
      ])
    );

    const locals = emittedLocals();
    expect(locals.innerOnly?.value).toBe('inner');
    expect(locals.outerOnly?.value).toBe('outer');
    expect(locals.arg?.value).toBe('arg-value');
    // Innermost block wins the shadow.
    expect(locals.x?.value).toBe('inner-x');
  });

  it('reads block scopes but no enclosing scopes when there is no local scope', async function () {
    // A module/top-level breakpoint may have no 'local' scope. Only block scopes
    // are read; closure/global must not be captured even though the loop never breaks.
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'block-1':
          return [{ name: 'blockVar', value: str('yes') }] as any[];
        case 'closure-1':
          return [{ name: 'moduleVar', value: str('should-not-capture') }] as any[];
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: [] });

    await collector.handlePaused(
      buildPausedParams([
        { type: 'block', objectId: 'block-1' },
        { type: 'closure', objectId: 'closure-1' },
      ])
    );

    const locals = emittedLocals();
    expect(locals.blockVar?.value).toBe('yes');
    expect(locals.moduleVar).toBeUndefined();
  });
});
