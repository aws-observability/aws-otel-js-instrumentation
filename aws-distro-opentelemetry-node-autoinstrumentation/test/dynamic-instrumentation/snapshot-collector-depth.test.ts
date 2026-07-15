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
 * Verifies depth limits in SnapshotCollector.collectValue via handlePaused with a
 * mocked inspector session whose local scope exposes nested structures.
 */
describe('SnapshotCollector depth limits', function () {
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

  function buildPausedParams(): inspector.Debugger.PausedEventDataType {
    return {
      callFrames: [
        {
          callFrameId: 'frame-1',
          functionName: 'testFunction',
          location: { scriptId: '1', lineNumber: 10 },
          url: 'file:///app/test.js',
          scopeChain: [
            {
              type: 'local',
              object: { type: 'object', objectId: 'scope-obj-1' },
            },
          ],
          this: { type: 'object' },
        },
      ] as any[],
      reason: 'other',
      hitBreakpoints: ['bp-1'],
    } as inspector.Debugger.PausedEventDataType;
  }

  function arrayRemoteObject(objectId: string): inspector.Runtime.RemoteObject {
    return { type: 'object', subtype: 'array', className: 'Array', objectId } as inspector.Runtime.RemoteObject;
  }

  function stubNestedArrayScope(): void {
    // Local scope: nested = [[[['deep']]]] — 4 levels of arrays.
    // V8 returns indexed properties BEFORE `length`, so `length` is placed last to
    // mirror real inspector ordering (the collector must not depend on encountering
    // `length` first).
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'scope-obj-1':
          return [{ name: 'nested', value: arrayRemoteObject('arr-0') }] as any[];
        case 'arr-0':
          return [
            { name: '0', value: arrayRemoteObject('arr-1') },
            { name: 'length', value: { type: 'number', value: 1 } },
          ] as any[];
        case 'arr-1':
          return [
            { name: '0', value: arrayRemoteObject('arr-2') },
            { name: 'length', value: { type: 'number', value: 1 } },
          ] as any[];
        case 'arr-2':
          return [
            { name: '0', value: arrayRemoteObject('arr-3') },
            { name: 'length', value: { type: 'number', value: 1 } },
          ] as any[];
        case 'arr-3':
          return [
            { name: '0', value: { type: 'string', value: 'deep' } },
            { name: 'length', value: { type: 'number', value: 1 } },
          ] as any[];
        default:
          return [] as any[];
      }
    });
  }

  function emittedLocals(): Record<string, any> {
    expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
    const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
    const lines = (snapshot.captures as any).lines;
    return lines[Object.keys(lines)[0]].locals;
  }

  it('should stop nested array capture at maxCollectionDepth', async function () {
    stubNestedArrayScope();
    registerConfig({ captureLocals: ['nested'], maxCollectionDepth: 1, maxObjectDepth: 3 });

    await collector.handlePaused(buildPausedParams());

    const nested = emittedLocals().nested;
    // Root array is serialized (collectionDepth 0); its array element hits the limit
    expect(nested.type).toBe('Array');
    expect(nested.elements).toHaveLength(1);
    expect(nested.elements[0].notCapturedReason).toBe('depth');
    expect(nested.elements[0].type).toBe('Array');
  });

  it('should capture nested arrays fully within maxCollectionDepth', async function () {
    stubNestedArrayScope();
    registerConfig({ captureLocals: ['nested'], maxCollectionDepth: 5, maxObjectDepth: 3 });

    await collector.handlePaused(buildPausedParams());

    const nested = emittedLocals().nested;
    const leaf = nested.elements[0].elements[0].elements[0].elements[0];
    expect(leaf.type).toBe('string');
    expect(leaf.value).toBe('deep');
  });

  it('should keep object depth independent from collection depth', async function () {
    // Local scope: holder = { items: ['x'] } — object nesting must not consume collection depth
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'scope-obj-1':
          return [{ name: 'holder', value: { type: 'object', className: 'Object', objectId: 'obj-holder' } }] as any[];
        case 'obj-holder':
          return [{ name: 'items', value: arrayRemoteObject('arr-items') }] as any[];
        case 'arr-items':
          return [
            { name: '0', value: { type: 'string', value: 'x' } },
            { name: 'length', value: { type: 'number', value: 1 } },
          ] as any[];
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: ['holder'], maxCollectionDepth: 1, maxObjectDepth: 3 });

    await collector.handlePaused(buildPausedParams());

    const holder = emittedLocals().holder;
    // items array is reached at collectionDepth 0 despite sitting at objectDepth 1
    expect(holder.fields.items.type).toBe('Array');
    expect(holder.fields.items.elements[0].value).toBe('x');
  });

  it('should report true length and truncated for arrays wider than maxCollectionWidth', async function () {
    // Local scope: big = [1..50]. V8 returns indexed props first, then `length` last —
    // the collector must read `length` up front, not rely on encountering it after the
    // element loop breaks at maxCollectionWidth. Regression test for size/truncated.
    const ARRAY_LEN = 50;
    const MAX_WIDTH = 20;
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'scope-obj-1':
          return [{ name: 'big', value: arrayRemoteObject('arr-big') }] as any[];
        case 'arr-big': {
          const props = [];
          for (let i = 0; i < ARRAY_LEN; i++) {
            props.push({ name: String(i), value: { type: 'number', value: i + 1 } });
          }
          // `length` placed LAST, as real V8 does
          props.push({ name: 'length', value: { type: 'number', value: ARRAY_LEN } });
          return props as any[];
        }
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: ['big'], maxCollectionWidth: MAX_WIDTH, maxCollectionDepth: 3 });

    await collector.handlePaused(buildPausedParams());

    const big = emittedLocals().big;
    expect(big.type).toBe('Array');
    expect(big.elements).toHaveLength(MAX_WIDTH); // capture capped at width
    expect(big.size).toBe(ARRAY_LEN); // but reported size is the true length
    expect(big.truncated).toBe(true);
    expect(big.elements[0].value).toBe('1');
    expect(big.elements[MAX_WIDTH - 1].value).toBe(String(MAX_WIDTH));
  });

  it('should report the logical length for sparse arrays (length > present elements)', async function () {
    // Local scope: sparse = []; sparse[0]='a'; sparse[99]='z'  -> length 100, 2 present.
    // V8 returns only the present indexed props plus `length`.
    // Note: this validates that `size` reflects the logical `.length` rather than the
    // count of present elements — it is NOT a guard for the break-before-length bug
    // (only the >maxCollectionWidth case above exercises the early-break path).
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'scope-obj-1':
          return [{ name: 'sparse', value: arrayRemoteObject('arr-sparse') }] as any[];
        case 'arr-sparse':
          return [
            { name: '0', value: { type: 'string', value: 'a' } },
            { name: '99', value: { type: 'string', value: 'z' } },
            { name: 'length', value: { type: 'number', value: 100 } },
          ] as any[];
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: ['sparse'], maxCollectionWidth: 20, maxCollectionDepth: 3 });

    await collector.handlePaused(buildPausedParams());

    const sparse = emittedLocals().sparse;
    expect(sparse.type).toBe('Array');
    expect(sparse.size).toBe(100); // logical .length, not the 2 present elements
    expect(sparse.elements).toHaveLength(2); // only present elements captured
    expect(sparse.truncated).toBe(true); // 100 > 20
  });

  it('should stop object recursion at maxObjectDepth', async function () {
    // Local scope: obj = { a: { b: 'deep' } } with maxObjectDepth 1
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'scope-obj-1':
          return [{ name: 'obj', value: { type: 'object', className: 'Object', objectId: 'obj-0' } }] as any[];
        case 'obj-0':
          return [{ name: 'a', value: { type: 'object', className: 'Object', objectId: 'obj-1' } }] as any[];
        case 'obj-1':
          return [{ name: 'b', value: { type: 'string', value: 'deep' } }] as any[];
        default:
          return [] as any[];
      }
    });
    registerConfig({ captureLocals: ['obj'], maxObjectDepth: 1, maxCollectionDepth: 3 });

    await collector.handlePaused(buildPausedParams());

    const obj = emittedLocals().obj;
    expect(obj.fields.a.notCapturedReason).toBe('depth');
  });
});
