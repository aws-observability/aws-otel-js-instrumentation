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

describe('SnapshotCollector trace context extraction', function () {
  let collector: SnapshotCollector;
  let mockSession: sinon.SinonStubbedInstance<InspectorSession>;
  let mockBreakpointManager: sinon.SinonStubbedInstance<BreakpointManager>;
  let mockRegistry: sinon.SinonStubbedInstance<InstrumentationRegistry>;
  let mockEmitter: sinon.SinonStubbedInstance<SnapshotOtlpEmitter>;
  let config: DynamicInstrumentationConfig;

  beforeEach(function () {
    mockSession = sinon.createStubInstance(InspectorSession);
    mockBreakpointManager = sinon.createStubInstance(BreakpointManager);
    mockRegistry = sinon.createStubInstance(InstrumentationRegistry);
    mockEmitter = sinon.createStubInstance(SnapshotOtlpEmitter);

    config = {
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
  });

  afterEach(function () {
    sinon.restore();
  });

  function buildPausedParams(options: {
    breakpointId?: string;
    callFrameId?: string;
    functionName?: string;
  }): inspector.Debugger.PausedEventDataType {
    return {
      callFrames: [
        {
          callFrameId: options.callFrameId ?? 'frame-1',
          functionName: options.functionName ?? 'testFunction',
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
      hitBreakpoints: options.breakpointId ? [options.breakpointId] : [],
    } as inspector.Debugger.PausedEventDataType;
  }

  describe('extractTraceContext via handlePaused', function () {
    beforeEach(function () {
      mockBreakpointManager.getRegistryKeyByV8Id.returns('test-key');
      mockRegistry.get.returns({
        config: {
          lineNumber: 11,
          filePath: 'test.js',
          locationHash: 'abc123',
          captureConfig: { captureLocals: null, captureStackTrace: false },
        },
        state: { recordHit: () => true },
      } as any);
      mockSession.getPropertiesAsync.resolves([]);
      mockSession.resumeAsync.resolves();
      mockSession.getFileResolver.returns({ getScriptUrl: () => 'file:///app/test.js' } as any);
      mockSession.getSourceMapResolver.returns({
        buildNameMapping: () => null,
        reverseMap: () => null,
      } as any);
    });

    it('should extract valid traceId and spanId from evaluateOnCallFrame result', async function () {
      const validTraceId = 'abcdef1234567890abcdef1234567890';
      const validSpanId = '1234567890abcdef';

      mockSession.evaluateOnCallFrameAsync.resolves({
        type: 'string',
        value: JSON.stringify({ traceId: validTraceId, spanId: validSpanId }),
      } as inspector.Runtime.RemoteObject);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe(validTraceId);
      expect(snapshot.trace.spanId).toBe(validSpanId);
    });

    it('should return empty trace fields when evaluateOnCallFrame returns null', async function () {
      mockSession.evaluateOnCallFrameAsync.resolves(null);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should return empty trace fields when expression returns error JSON', async function () {
      mockSession.evaluateOnCallFrameAsync.resolves({
        type: 'string',
        value: JSON.stringify({ error: 'no otel global' }),
      } as inspector.Runtime.RemoteObject);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should return empty trace fields when expression returns empty object', async function () {
      mockSession.evaluateOnCallFrameAsync.resolves({
        type: 'string',
        value: '{}',
      } as inspector.Runtime.RemoteObject);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should return empty trace fields when expression returns non-string type', async function () {
      mockSession.evaluateOnCallFrameAsync.resolves({
        type: 'undefined',
      } as inspector.Runtime.RemoteObject);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should return empty trace fields when expression returns invalid JSON', async function () {
      mockSession.evaluateOnCallFrameAsync.resolves({
        type: 'string',
        value: 'not-json',
      } as inspector.Runtime.RemoteObject);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should return empty trace fields when evaluateOnCallFrame throws', async function () {
      mockSession.evaluateOnCallFrameAsync.rejects(new Error('Inspector call timed out'));

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should not crash or affect snapshot creation when trace extraction fails', async function () {
      mockSession.evaluateOnCallFrameAsync.rejects(new Error('session disconnected'));

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      // Snapshot should still be emitted
      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.id).toBeDefined();
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should return empty trace fields when traceId is present but spanId is missing', async function () {
      mockSession.evaluateOnCallFrameAsync.resolves({
        type: 'string',
        value: JSON.stringify({ traceId: 'abc123', spanId: '' }),
      } as inspector.Runtime.RemoteObject);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should return empty trace fields when callFrameId is missing', async function () {
      const params = buildPausedParams({ breakpointId: 'bp-1' });
      // Remove callFrameId from the frame
      (params.callFrames[0] as any).callFrameId = undefined;

      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
      // evaluateOnCallFrameAsync should not have been called
      expect(mockSession.evaluateOnCallFrameAsync.called).toBe(false);
    });

    it('should return empty trace fields when traceId is all zeros (invalid)', async function () {
      mockSession.evaluateOnCallFrameAsync.resolves({
        type: 'string',
        value: JSON.stringify({
          traceId: '00000000000000000000000000000000',
          spanId: '1234567890abcdef',
        }),
      } as inspector.Runtime.RemoteObject);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should return empty trace fields when spanId is all zeros (invalid)', async function () {
      mockSession.evaluateOnCallFrameAsync.resolves({
        type: 'string',
        value: JSON.stringify({
          traceId: 'abcdef1234567890abcdef1234567890',
          spanId: '0000000000000000',
        }),
      } as inspector.Runtime.RemoteObject);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });

    it('should return empty trace fields when traceId has invalid format', async function () {
      mockSession.evaluateOnCallFrameAsync.resolves({
        type: 'string',
        value: JSON.stringify({
          traceId: 'not-a-valid-hex-trace-id',
          spanId: '1234567890abcdef',
        }),
      } as inspector.Runtime.RemoteObject);

      const params = buildPausedParams({ breakpointId: 'bp-1' });
      await collector.handlePaused(params);

      expect(mockEmitter.emitSnapshot.calledOnce).toBe(true);
      const snapshot = mockEmitter.emitSnapshot.firstCall.args[0];
      expect(snapshot.trace.traceId).toBe('');
      expect(snapshot.trace.spanId).toBe('');
    });
  });
});
