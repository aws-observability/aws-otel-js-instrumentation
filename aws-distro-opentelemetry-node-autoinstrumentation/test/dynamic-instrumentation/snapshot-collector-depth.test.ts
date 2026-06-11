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
    // Local scope: nested = [[[['deep']]]] — 4 levels of arrays
    mockSession.getPropertiesAsync.callsFake(async (objectId: string) => {
      switch (objectId) {
        case 'scope-obj-1':
          return [{ name: 'nested', value: arrayRemoteObject('arr-0') }] as any[];
        case 'arr-0':
          return [
            { name: 'length', value: { type: 'number', value: 1 } },
            { name: '0', value: arrayRemoteObject('arr-1') },
          ] as any[];
        case 'arr-1':
          return [
            { name: 'length', value: { type: 'number', value: 1 } },
            { name: '0', value: arrayRemoteObject('arr-2') },
          ] as any[];
        case 'arr-2':
          return [
            { name: 'length', value: { type: 'number', value: 1 } },
            { name: '0', value: arrayRemoteObject('arr-3') },
          ] as any[];
        case 'arr-3':
          return [
            { name: 'length', value: { type: 'number', value: 1 } },
            { name: '0', value: { type: 'string', value: 'deep' } },
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
            { name: 'length', value: { type: 'number', value: 1 } },
            { name: '0', value: { type: 'string', value: 'x' } },
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
