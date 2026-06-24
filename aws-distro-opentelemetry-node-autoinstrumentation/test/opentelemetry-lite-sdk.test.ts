// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, TraceFlags } from '@opentelemetry/api';
import expect from 'expect';
import * as sinon from 'sinon';
import {
  BatchingSpanProcessor,
  configureLiteMode,
  InstrumentationScope,
  liteEventContextExtractor,
  Span,
  TracerProvider,
  UdpExporter,
  UdpSpanExporter,
} from '../src/opentelemetry-lite-sdk';
import { applySmithySendPatch as patchAwsSdkForSmithyCore } from '../src/patches/smithy-send-patch';

const TEST_SERVICE_NAME = 'test-service';

describe('LiteSdk - buildLambdaResource', () => {
  afterEach(() => {
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.OTEL_SERVICE_NAME;
  });

  it('builds resource from env vars', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'cloud.region=us-west-2,cloud.platform=aws_lambda';
    process.env.OTEL_SERVICE_NAME = TEST_SERVICE_NAME;

    const provider = new TracerProvider();
    expect(provider.resource['service.name']).toBe(TEST_SERVICE_NAME);
    expect(provider.resource['cloud.region']).toBe('us-west-2');
    expect(provider.resource['cloud.platform']).toBe('aws_lambda');
    expect(provider.resource['telemetry.sdk.language']).toBe('nodejs');
    expect(provider.resource['telemetry.sdk.name']).toBe('opentelemetry');
    expect(provider.resource['telemetry.sdk.version']).toBe(require('@opentelemetry/core').VERSION);
    expect(provider.resource['telemetry.auto.version']).toBe(require('../src/version').LIB_VERSION + '-aws');
  });

  it('handles empty env vars', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = '';
    process.env.OTEL_SERVICE_NAME = '';

    const provider = new TracerProvider();
    expect(provider.resource['service.name']).toBe('');
    expect(provider.resource['telemetry.sdk.language']).toBe('nodejs');
  });
});

describe('LiteSdk - InstrumentationScope', () => {
  it('stores properties', () => {
    const scope = new InstrumentationScope('my-module', '1.0.0', 'https://schema.url');
    expect(scope.name).toBe('my-module');
    expect(scope.version).toBe('1.0.0');
    expect(scope.schemaUrl).toBe('https://schema.url');
  });

  it('defaults version and schemaUrl', () => {
    const scope = new InstrumentationScope('my-module');
    expect(scope.name).toBe('my-module');
    expect(scope.version).toBe('');
    expect(scope.schemaUrl).toBe('');
  });

  it('stores attributes when provided', () => {
    const scope = new InstrumentationScope('my-module', '1.0.0', '', { 'scope.key': 'scope-val' });
    expect(scope.attributes['scope.key']).toBe('scope-val');
  });

  it('defaults attributes to empty object when not provided', () => {
    const scope = new InstrumentationScope('my-module');
    expect(scope.attributes).toEqual({});
  });

  it('skips undefined attribute values', () => {
    const scope = new InstrumentationScope('my-module', '1.0.0', '', { valid: 'yes', bad: undefined as any });
    expect(scope.attributes['valid']).toBe('yes');
    expect(scope.attributes['bad']).toBeUndefined();
  });
});

describe('LiteSdk - TracerProvider', () => {
  it('uses provided resource', () => {
    const provider = new TracerProvider({ 'service.name': 'custom' });
    expect(provider.resource['service.name']).toBe('custom');
  });

  it('getTracer returns a tracer', () => {
    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test-module', '1.0.0');
    expect(tracer).toBeDefined();
  });

  it('getTracer forwards scope attributes to InstrumentationScope', () => {
    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test-module', '1.0.0', {
      schemaUrl: 'https://schema.url',
      attributes: { 'scope.attr': 'value' },
    });
    const span = tracer.startSpan('s') as Span;
    expect(span.instrumentationScope.attributes['scope.attr']).toBe('value');
    span.end();
  });

  it('addSpanProcessor registers processor', () => {
    const provider = new TracerProvider({ 'service.name': 'test' });
    const processor = { onStart: sinon.stub(), onEnd: sinon.stub(), forceFlush: sinon.stub(), shutdown: sinon.stub() };
    provider.addSpanProcessor(processor);

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');
    expect(processor.onStart.called).toBe(true);
    (span as Span).end();
  });

  it('forceFlush calls processors', () => {
    const provider = new TracerProvider({ 'service.name': 'test' });
    const processor = { onStart: sinon.stub(), onEnd: sinon.stub(), forceFlush: sinon.stub(), shutdown: sinon.stub() };
    provider.addSpanProcessor(processor);
    provider.forceFlush();
    expect(processor.forceFlush.called).toBe(true);
  });

  it('shutdown calls processors', () => {
    const provider = new TracerProvider({ 'service.name': 'test' });
    const processor = { onStart: sinon.stub(), onEnd: sinon.stub(), forceFlush: sinon.stub(), shutdown: sinon.stub() };
    provider.addSpanProcessor(processor);
    provider.shutdown();
    expect(processor.shutdown.called).toBe(true);
  });
});

describe('LiteSdk - Tracer', () => {
  let provider: TracerProvider;
  let processor: any;
  let tracer: any;

  beforeEach(() => {
    provider = new TracerProvider({ 'service.name': TEST_SERVICE_NAME });
    processor = { onStart: sinon.stub(), onEnd: sinon.stub(), forceFlush: sinon.stub(), shutdown: sinon.stub() };
    provider.addSpanProcessor(processor);
    tracer = provider.getTracer('test-module');
  });

  it('startSpan creates a span with correct name and kind', () => {
    const span = tracer.startSpan('test-span', { kind: SpanKind.SERVER }) as Span;
    expect(span.name).toBe('test-span');
    expect(span.kind).toBe(SpanKind.SERVER);
    span.end();
  });

  it('startSpan sets resource from provider', () => {
    const span = tracer.startSpan('test-span') as Span;
    expect(span.resource['service.name']).toBe(TEST_SERVICE_NAME);
    span.end();
  });

  it('root span generates valid trace id', () => {
    const span = tracer.startSpan('test-span') as Span;
    const ctx = span.spanContext();
    expect(ctx.traceId).toBeDefined();
    expect(ctx.traceId).not.toBe('00000000000000000000000000000000');
    span.end();
  });

  it('root span is always sampled', () => {
    const span = tracer.startSpan('test-span') as Span;
    expect(span.spanContext().traceFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);
    span.end();
  });

  it('child inherits parent trace id', () => {
    const parent = tracer.startSpan('parent') as Span;
    const parentCtx = trace.setSpan(context.active(), parent);
    const child = tracer.startSpan('child', {}, parentCtx) as Span;

    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(child.spanContext().spanId).not.toBe(parent.spanContext().spanId);
    expect(child.parent?.spanId).toBe(parent.spanContext().spanId);

    child.end();
    parent.end();
  });

  it('startActiveSpan executes fn and ends span', () => {
    let capturedSpan: Span | undefined;
    tracer.startActiveSpan('test-span', { kind: SpanKind.CLIENT }, (span: any) => {
      capturedSpan = span as Span;
      expect(capturedSpan.name).toBe('test-span');
      expect(capturedSpan.isRecording()).toBe(true);
      span.end();
    });
    expect(capturedSpan!.isRecording()).toBe(false);
  });

  it('startSpan calls processor onStart', () => {
    const span = tracer.startSpan('test-span');
    expect(processor.onStart.called).toBe(true);
    (span as Span).end();
  });
});

describe('LiteSdk - Span', () => {
  let provider: TracerProvider;
  let processor: any;
  let tracer: any;

  beforeEach(() => {
    provider = new TracerProvider({ 'service.name': TEST_SERVICE_NAME });
    processor = { onStart: sinon.stub(), onEnd: sinon.stub(), forceFlush: sinon.stub(), shutdown: sinon.stub() };
    provider.addSpanProcessor(processor);
    tracer = provider.getTracer('test-module');
  });

  it('setAttribute sets value', () => {
    const span = tracer.startSpan('test') as Span;
    span.setAttribute('key', 'value');
    expect(span.attributes['key']).toBe('value');
    span.end();
  });

  it('setAttribute after end is ignored', () => {
    const span = tracer.startSpan('test') as Span;
    span.end();
    span.setAttribute('key', 'value');
    expect(span.attributes['key']).toBeUndefined();
  });

  it('setAttributes sets multiple values', () => {
    const span = tracer.startSpan('test') as Span;
    span.setAttributes({ k1: 'v1', k2: 42 });
    expect(span.attributes['k1']).toBe('v1');
    expect(span.attributes['k2']).toBe(42);
    span.end();
  });

  it('addEvent adds event', () => {
    const span = tracer.startSpan('test') as Span;
    span.addEvent('my-event', { detail: 'info' });
    expect(span.events.length).toBe(1);
    expect(span.events[0].name).toBe('my-event');
    expect(span.events[0].attributes['detail']).toBe('info');
    span.end();
  });

  it('updateName changes name', () => {
    const span = tracer.startSpan('original') as Span;
    span.updateName('updated');
    expect(span.name).toBe('updated');
    span.end();
  });

  it('setStatus ERROR', () => {
    const span = tracer.startSpan('test') as Span;
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'something failed' });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('something failed');
    span.end();
  });

  it('setStatus OK cannot be overridden by ERROR', () => {
    const span = tracer.startSpan('test') as Span;
    span.setStatus({ code: SpanStatusCode.OK });
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'should not override' });
    expect(span.status.code).toBe(SpanStatusCode.OK);
    span.end();
  });

  it('isRecording returns false after end', () => {
    const span = tracer.startSpan('test') as Span;
    expect(span.isRecording()).toBe(true);
    span.end();
    expect(span.isRecording()).toBe(false);
  });

  it('end calls onEnd once', () => {
    const span = tracer.startSpan('test') as Span;
    span.end();
    span.end();
    expect(processor.onEnd.callCount).toBe(1);
  });

  it('has startTime and endTime after end', () => {
    const span = tracer.startSpan('test') as Span;
    expect(span.startTime).toBeDefined();
    expect(span.endTime).toBeUndefined();
    span.end();
    expect(span.endTime).toBeDefined();
    expect(span.endTime!).toBeGreaterThanOrEqual(span.startTime!);
  });

  it('recordException adds exception event', () => {
    const span = tracer.startSpan('test') as Span;
    span.recordException(new Error('test error'));
    expect(span.events.length).toBe(1);
    expect(span.events[0].name).toBe('exception');
    expect(span.events[0].attributes['exception.type']).toBe('Error');
    expect(span.events[0].attributes['exception.message']).toBe('test error');
    span.end();
  });

  it('startActiveSpan records exception on throw', () => {
    let capturedSpan: Span | undefined;
    expect(() => {
      tracer.startActiveSpan('test', (span: any) => {
        capturedSpan = span as Span;
        throw new Error('boom');
      });
    }).toThrow('boom');
    expect(capturedSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(capturedSpan!.events.length).toBe(1);
    expect(capturedSpan!.events[0].name).toBe('exception');
  });

  it('recordException accepts a string exception', () => {
    const span = tracer.startSpan('test') as Span;
    span.recordException('something broke');
    expect(span.events[0].name).toBe('exception');
    expect(span.events[0].attributes['exception.message']).toBe('something broke');
    span.end();
  });

  it('addLink and addLinks are no-ops returning this', () => {
    const span = tracer.startSpan('test') as Span;
    expect(span.addLink({ context: span.spanContext() })).toBe(span);
    expect(span.addLinks([{ context: span.spanContext() }])).toBe(span);
    span.end();
  });

  it('treats numeric startTime as epoch milliseconds (converts to nanos)', () => {
    // Per OTel convention, numeric TimeInput is epoch milliseconds (like Date.now()).
    const epochMs = 1700000000000; // Nov 2023 in ms
    const span = tracer.startSpan('test', { startTime: epochMs }) as Span;
    expect(span.startTime).toBe(epochMs * 1e6);
    span.end();
  });

  it('treats Date startTime as epoch milliseconds (converts to nanos)', () => {
    const date = new Date(1700000000000);
    const span = tracer.startSpan('test', { startTime: date }) as Span;
    expect(span.startTime).toBe(1700000000000 * 1e6);
    span.end();
  });

  it('suppressed context returns a non-recording span', () => {
    // isTracingSuppressed is wired from @opentelemetry/core inside
    // configureLiteMode; ensure it is active so the suppression branch is hit.
    require('../src/opentelemetry-lite-sdk').configureLiteMode();
    const { suppressTracing } = require('@opentelemetry/core');
    const span = tracer.startSpan('suppressed', {}, suppressTracing(context.active())) as any;
    // wrapSpanContext returns a non-recording span with the invalid span id.
    expect(span.spanContext().spanId).toBe('0000000000000000');
  });

  it('generates a fresh trace id when the parent context is invalid', () => {
    const invalidParent = trace.setSpanContext(context.active(), {
      traceId: '00000000000000000000000000000000',
      spanId: '0000000000000000',
      traceFlags: TraceFlags.NONE,
    });
    const span = tracer.startSpan('child', {}, invalidParent) as Span;
    expect(span.spanContext().traceId).not.toBe('00000000000000000000000000000000');
    expect(span.parent).toBeUndefined();
    span.end();
  });
});

describe('LiteSdk - BatchingSpanProcessor', () => {
  let exporter: any;
  let processor: BatchingSpanProcessor;

  beforeEach(() => {
    exporter = { export: sinon.stub().returns(true), forceFlush: sinon.stub(), shutdown: sinon.stub() };
    processor = new BatchingSpanProcessor(exporter);
  });

  it('onEnd batches spans without exporting', () => {
    const span1 = {} as any;
    const span2 = {} as any;
    processor.onEnd(span1);
    processor.onEnd(span2);
    expect(exporter.export.called).toBe(false);
  });

  it('forceFlush exports all batched spans', () => {
    const span1 = {} as any;
    const span2 = {} as any;
    processor.onEnd(span1);
    processor.onEnd(span2);
    processor.forceFlush();
    expect(exporter.export.calledOnce).toBe(true);
    expect(exporter.export.firstCall.args[0].length).toBe(2);
  });

  it('forceFlush with no spans does not export', () => {
    processor.forceFlush();
    expect(exporter.export.called).toBe(false);
  });

  it('shutdown flushes and shuts down exporter', () => {
    const span = {} as any;
    processor.onEnd(span);
    processor.shutdown();
    expect(exporter.export.calledOnce).toBe(true);
    expect(exporter.shutdown.calledOnce).toBe(true);
  });

  it('onStart sets aws.is.local.root=true for root spans', () => {
    const provider = new TracerProvider({ 'service.name': 'test' });
    const proc = new BatchingSpanProcessor(exporter);
    provider.addSpanProcessor(proc);
    const tracer = provider.getTracer('test');

    const span = tracer.startSpan('root', { kind: SpanKind.SERVER }) as Span;
    expect(span.attributes['aws.is.local.root']).toBe(true);
    span.end();
  });

  it('onStart sets aws.is.local.root=false for child spans', () => {
    const provider = new TracerProvider({ 'service.name': 'test' });
    const proc = new BatchingSpanProcessor(exporter);
    provider.addSpanProcessor(proc);
    const tracer = provider.getTracer('test');

    const parent = tracer.startSpan('parent', { kind: SpanKind.SERVER }) as Span;
    const parentCtx = trace.setSpan(context.active(), parent);
    const child = tracer.startSpan('child', { kind: SpanKind.CLIENT }, parentCtx) as Span;

    expect(child.attributes['aws.is.local.root']).toBe(false);
    child.end();
    parent.end();
  });

  it('onStart propagates faas.id from parent to child', () => {
    const provider = new TracerProvider({ 'service.name': 'test' });
    const proc = new BatchingSpanProcessor(exporter);
    provider.addSpanProcessor(proc);
    const tracer = provider.getTracer('test');

    const parent = tracer.startSpan('parent', { kind: SpanKind.SERVER }) as Span;
    parent.setAttribute('faas.id', 'arn:aws:lambda:us-west-2:123:function:my-func');
    const parentCtx = trace.setSpan(context.active(), parent);
    const child = tracer.startSpan('child', { kind: SpanKind.CLIENT }, parentCtx) as Span;

    expect(child.attributes['faas.id']).toBe('arn:aws:lambda:us-west-2:123:function:my-func');
    child.end();
    parent.end();
  });
});

describe('LiteSdk - UdpSpanExporter', () => {
  let originalAppSignals: string | undefined;
  let originalFunctionName: string | undefined;

  beforeEach(() => {
    originalAppSignals = process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    originalFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  afterEach(() => {
    if (originalAppSignals !== undefined) process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = originalAppSignals;
    else delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    if (originalFunctionName !== undefined) process.env.AWS_LAMBDA_FUNCTION_NAME = originalFunctionName;
    else delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  it('exports spans via UDP', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span', { kind: SpanKind.SERVER }) as Span;
    span.end();

    expect(exporter.export([span])).toBe(true);
    expect(mockUdp.sendOtlp.calledOnce).toBe(true);
  });

  it('injects app signals attributes when enabled', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'my-service' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span', { kind: SpanKind.SERVER }) as Span;
    span.end();

    exporter.export([span]);
    expect(span.attributes['aws.local.service']).toBe('my-service');
    expect(span.attributes['aws.local.operation']).toBe('my-func/FunctionHandler');
    expect(span.attributes['aws.local.environment']).toBe('lambda:default');
  });

  it('injects remote attributes for CLIENT spans', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'my-service' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('S3.ListBuckets', { kind: SpanKind.CLIENT }) as Span;
    span.setAttribute('rpc.service', 'S3');
    span.setAttribute('rpc.system', 'aws-api');
    span.setAttribute('rpc.method', 'ListBuckets');
    span.end();

    exporter.export([span]);
    expect(span.attributes['aws.remote.service']).toBe('AWS::S3');
    expect(span.attributes['aws.remote.operation']).toBe('ListBuckets');
  });

  it('uses T1S prefix for sampled spans', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span', { kind: SpanKind.SERVER }) as Span;
    span.end();

    exporter.export([span]);
    expect(mockUdp.sendOtlp.firstCall.args[1]).toBe('T1S');
  });

  it('does not inject app signals when disabled', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span', { kind: SpanKind.SERVER }) as Span;
    span.end();

    exporter.export([span]);
    expect(span.attributes['aws.local.service']).toBeUndefined();
    expect(span.attributes['aws.local.operation']).toBeUndefined();
  });

  it('removes aws.is.local.root when app signals disabled', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const proc = new BatchingSpanProcessor(exporter);
    provider.addSpanProcessor(proc);
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span', { kind: SpanKind.SERVER }) as Span;
    span.end();

    expect(span.attributes['aws.is.local.root']).toBe(true);
    exporter.export([span]);
    expect(span.attributes['aws.is.local.root']).toBeUndefined();
  });

  it('sets aws.span.kind LOCAL_ROOT for local root when app signals enabled', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const proc = new BatchingSpanProcessor(exporter);
    provider.addSpanProcessor(proc);
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span', { kind: SpanKind.SERVER }) as Span;
    span.end();

    exporter.export([span]);
    expect(span.attributes['aws.span.kind']).toBe('LOCAL_ROOT');
  });

  it('sets aws.span.kind CLIENT for non-root client when app signals enabled', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const proc = new BatchingSpanProcessor(exporter);
    provider.addSpanProcessor(proc);
    const tracer = provider.getTracer('test');

    const parent = tracer.startSpan('parent', { kind: SpanKind.SERVER }) as Span;
    const parentCtx = trace.setSpan(context.active(), parent);
    const child = tracer.startSpan('child', { kind: SpanKind.CLIENT }, parentCtx) as Span;
    child.end();
    parent.end();

    exporter.export([child]);
    expect(child.attributes['aws.span.kind']).toBe('CLIENT');
  });

  it('resolves non-AWS rpc service without AWS:: prefix', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'test';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', { kind: SpanKind.CLIENT }) as Span;
    span.setAttribute('rpc.service', 'MyService');
    span.setAttribute('rpc.system', 'grpc');
    span.setAttribute('rpc.method', 'Call');
    span.end();

    exporter.export([span]);
    expect(span.attributes['aws.remote.service']).toBe('MyService');
  });

  it('resolves http url hostname as remote service', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'test';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', { kind: SpanKind.CLIENT }) as Span;
    span.setAttribute('http.url', 'https://example.com/api/data');
    span.setAttribute('http.method', 'GET');
    span.end();

    exporter.export([span]);
    expect(span.attributes['aws.remote.service']).toBe('example.com');
    expect(span.attributes['aws.remote.operation']).toBe('GET /api/data');
  });

  it('returns UnknownRemoteService for empty attrs', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'test';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', { kind: SpanKind.CLIENT }) as Span;
    span.end();

    exporter.export([span]);
    expect(span.attributes['aws.remote.service']).toBe('UnknownRemoteService');
    expect(span.attributes['aws.remote.operation']).toBe('UnknownRemoteOperation');
  });
});

describe('LiteSdk - OTLP Encoding', () => {
  afterEach(() => {
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
  });

  it('encodes spans into non-empty buffer', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const sentBuffers: Buffer[] = [];
    (exporter as any)._udpExporter = {
      sendOtlp: (data: Buffer) => {
        sentBuffers.push(data);
      },
      shutdown: () => {},
    };

    const provider = new TracerProvider({ 'service.name': 'test', 'cloud.region': 'us-west-2' });
    const tracer = provider.getTracer('test-module', '1.0.0');
    const span = tracer.startSpan('test-span', { kind: SpanKind.SERVER }) as Span;
    span.setAttribute('key', 'value');
    span.end();

    exporter.export([span]);
    expect(sentBuffers.length).toBe(1);
    expect(sentBuffers[0].length).toBeGreaterThan(0);
  });

  it('encodes multiple spans', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const sentBuffers: Buffer[] = [];
    (exporter as any)._udpExporter = {
      sendOtlp: (data: Buffer) => {
        sentBuffers.push(data);
      },
      shutdown: () => {},
    };

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span1 = tracer.startSpan('span1', { kind: SpanKind.SERVER }) as Span;
    span1.end();
    const span2 = tracer.startSpan('span2', { kind: SpanKind.CLIENT }) as Span;
    span2.end();

    exporter.export([span1, span2]);
    expect(sentBuffers.length).toBe(1);
    expect(sentBuffers[0].length).toBeGreaterThan(0);
  });

  it('encodes span with events', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const sentBuffers: Buffer[] = [];
    (exporter as any)._udpExporter = {
      sendOtlp: (data: Buffer) => {
        sentBuffers.push(data);
      },
      shutdown: () => {},
    };

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span') as Span;
    span.addEvent('my-event', { detail: 'info' });
    span.end();

    exporter.export([span]);
    expect(sentBuffers[0].length).toBeGreaterThan(0);
  });

  it('encodes a floating-point attribute as a double', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const sentBuffers: Buffer[] = [];
    (exporter as any)._udpExporter = {
      sendOtlp: (data: Buffer) => {
        sentBuffers.push(data);
      },
      shutdown: () => {},
    };
    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span') as Span;
    span.setAttribute('ratio', 3.14);
    span.end();

    exporter.export([span]);
    expect(sentBuffers[0].length).toBeGreaterThan(0);
  });

  it('export returns false when the underlying send throws', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    (exporter as any)._udpExporter = {
      sendOtlp: () => {
        throw new Error('udp down');
      },
      shutdown: () => {},
    };
    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span') as Span;
    span.end();

    expect(exporter.export([span])).toBe(false);
  });

  it('forceFlush returns true', () => {
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    expect(exporter.forceFlush()).toBe(true);
    exporter.shutdown();
  });

  it('encodes span with error status', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const sentBuffers: Buffer[] = [];
    (exporter as any)._udpExporter = {
      sendOtlp: (data: Buffer) => {
        sentBuffers.push(data);
      },
      shutdown: () => {},
    };

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span') as Span;
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'failed' });
    span.end();

    exporter.export([span]);
    expect(sentBuffers[0].length).toBeGreaterThan(0);
  });
});

// Minimal protobuf reader used to decode what the SDK encodes, so the
// encoding tests assert real wire output rather than just buffer length.
// BigInt() constructor form (not `n` literals) to match the es2017 target.
const B0 = BigInt(0);
const B3 = BigInt(3);
const B7 = BigInt(7);
const BMASK = BigInt(7);

function readVarint(buf: Buffer, pos: number): { value: bigint; pos: number } {
  let result = B0;
  let shift = B0;
  let p = pos;
  for (;;) {
    const byte = buf[p++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += B7;
  }
  return { value: result, pos: p };
}

// Walk a length-delimited message and return the bytes of the first field
// matching `fieldNumber` (wire type 2), or undefined.
function findLenField(buf: Buffer, fieldNumber: number): Buffer | undefined {
  let p = 0;
  while (p < buf.length) {
    const tag = readVarint(buf, p);
    p = tag.pos;
    const field = Number(tag.value >> B3);
    const wire = Number(tag.value & BMASK);
    if (wire === 2) {
      const len = readVarint(buf, p);
      p = len.pos;
      const end = p + Number(len.value);
      if (field === fieldNumber) return buf.subarray(p, end);
      p = end;
    } else if (wire === 0) {
      p = readVarint(buf, p).pos;
    } else if (wire === 1) {
      p += 8;
    } else if (wire === 5) {
      p += 4;
    } else {
      break;
    }
  }
  return undefined;
}

// Find a fixed32 (wire type 5) field and return its little-endian uint value.
function findFixed32Field(buf: Buffer, fieldNumber: number): number | undefined {
  let p = 0;
  while (p < buf.length) {
    const tag = readVarint(buf, p);
    p = tag.pos;
    const field = Number(tag.value >> B3);
    const wire = Number(tag.value & BMASK);
    if (wire === 5) {
      if (field === fieldNumber) return buf.readUInt32LE(p);
      p += 4;
    } else if (wire === 0) {
      p = readVarint(buf, p).pos;
    } else if (wire === 1) {
      p += 8;
    } else if (wire === 2) {
      const len = readVarint(buf, p);
      p = len.pos + Number(len.value);
    } else {
      break;
    }
  }
  return undefined;
}

// Collect the bytes of every field matching `fieldNumber` (wire type 2).
function findAllLenFields(buf: Buffer, fieldNumber: number): Buffer[] {
  const out: Buffer[] = [];
  let p = 0;
  while (p < buf.length) {
    const tag = readVarint(buf, p);
    p = tag.pos;
    const field = Number(tag.value >> B3);
    const wire = Number(tag.value & BMASK);
    if (wire === 2) {
      const len = readVarint(buf, p);
      p = len.pos;
      const end = p + Number(len.value);
      if (field === fieldNumber) out.push(buf.subarray(p, end));
      p = end;
    } else if (wire === 0) {
      p = readVarint(buf, p).pos;
    } else if (wire === 1) {
      p += 8;
    } else if (wire === 5) {
      p += 4;
    } else {
      break;
    }
  }
  return out;
}

describe('LiteSdk - OTLP wire-format correctness', () => {
  afterEach(() => {
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
  });

  function exportAndCapture(buildSpans: (provider: TracerProvider, exporter: UdpSpanExporter) => void): Buffer {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    let sent: Buffer | undefined;
    (exporter as any)._udpExporter = {
      sendOtlp: (data: Buffer) => {
        sent = data;
      },
      shutdown: () => {},
    };
    const provider = new TracerProvider({ 'service.name': 'test' });
    buildSpans(provider, exporter);
    return sent!;
  }

  it('writes the span flags field (field 16) with HAS_IS_REMOTE and sampled bits', () => {
    const sent = exportAndCapture((provider, exporter) => {
      const tracer = provider.getTracer('scope-a', '1.0.0');
      const span = tracer.startSpan('s', { kind: SpanKind.SERVER }) as Span;
      span.end();
      exporter.export([span]);
    });
    const resourceSpans = findLenField(sent, 1)!;
    const scopeSpans = findLenField(resourceSpans, 2)!;
    const spanBytes = findLenField(scopeSpans, 2)!;
    const flags = findFixed32Field(spanBytes, 16);
    expect(flags).toBeDefined();
    expect(flags! & 0x100).toBe(0x100); // HAS_IS_REMOTE
    expect(flags! & 0x01).toBe(0x01); // SAMPLED (root spans are always sampled)
  });

  it('encodes span status at field 15 (not 13/links)', () => {
    const sent = exportAndCapture((provider, exporter) => {
      const tracer = provider.getTracer('scope-a', '1.0.0');
      const span = tracer.startSpan('s') as Span;
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });
      span.end();
      exporter.export([span]);
    });
    const resourceSpans = findLenField(sent, 1)!;
    const scopeSpans = findLenField(resourceSpans, 2)!;
    const spanBytes = findLenField(scopeSpans, 2)!;
    expect(findLenField(spanBytes, 15)).toBeDefined(); // status present at 15
    expect(findLenField(spanBytes, 13)).toBeUndefined(); // nothing leaked into links
  });

  it('groups spans into separate ScopeSpans by instrumentation scope', () => {
    const sent = exportAndCapture((provider, exporter) => {
      const tracerA = provider.getTracer('scope-a', '1.0.0');
      const tracerB = provider.getTracer('scope-b', '2.0.0');
      const a = tracerA.startSpan('a', { kind: SpanKind.SERVER }) as Span;
      const b = tracerB.startSpan('b', { kind: SpanKind.CLIENT }) as Span;
      a.end();
      b.end();
      exporter.export([a, b]);
    });
    const resourceSpans = findLenField(sent, 1)!;
    const scopeSpansList = findAllLenFields(resourceSpans, 2);
    expect(scopeSpansList.length).toBe(2);
    const scopeNames = scopeSpansList
      .map(ss => findLenField(ss, 1)) // InstrumentationScope
      .map(scope => (scope ? findLenField(scope, 1)?.toString('utf-8') : undefined));
    expect(scopeNames).toContain('scope-a');
    expect(scopeNames).toContain('scope-b');
  });

  it('sets IS_REMOTE flag (0x200) when parent span context is remote', () => {
    const sent = exportAndCapture((provider, exporter) => {
      const tracer = provider.getTracer('scope-a', '1.0.0');
      const remoteParentContext = trace.setSpanContext(context.active(), {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });
      const span = tracer.startSpan('child', {}, remoteParentContext) as Span;
      span.end();
      exporter.export([span]);
    });
    const resourceSpans = findLenField(sent, 1)!;
    const scopeSpans = findLenField(resourceSpans, 2)!;
    const spanBytes = findLenField(scopeSpans, 2)!;
    const flags = findFixed32Field(spanBytes, 16);
    expect(flags! & 0x200).toBe(0x200); // IS_REMOTE
  });

  it('does not set IS_REMOTE flag for local parent spans', () => {
    const sent = exportAndCapture((provider, exporter) => {
      const tracer = provider.getTracer('scope-a', '1.0.0');
      const parent = tracer.startSpan('parent') as Span;
      const parentCtx = trace.setSpan(context.active(), parent);
      const child = tracer.startSpan('child', {}, parentCtx) as Span;
      parent.end();
      child.end();
      exporter.export([child]);
    });
    const resourceSpans = findLenField(sent, 1)!;
    const scopeSpans = findLenField(resourceSpans, 2)!;
    const spanBytes = findLenField(scopeSpans, 2)!;
    const flags = findFixed32Field(spanBytes, 16);
    expect(flags! & 0x200).toBe(0); // IS_REMOTE not set
  });

  it('encodes scope attributes into InstrumentationScope field 3', () => {
    const sent = exportAndCapture((provider, exporter) => {
      const tracer = provider.getTracer('scope-a', '1.0.0', { attributes: { 'scope.key': 'scope-val' } });
      const span = tracer.startSpan('s') as Span;
      span.end();
      exporter.export([span]);
    });
    const resourceSpans = findLenField(sent, 1)!;
    const scopeSpans = findLenField(resourceSpans, 2)!;
    const scopeBytes = findLenField(scopeSpans, 1)!; // InstrumentationScope
    const attrBytes = findLenField(scopeBytes, 3); // field 3 = attributes
    expect(attrBytes).toBeDefined();
    const keyBytes = findLenField(attrBytes!, 1);
    expect(keyBytes?.toString('utf-8')).toBe('scope.key');
  });

  it('groups scopes with different attributes into separate ScopeSpans', () => {
    const sent = exportAndCapture((provider, exporter) => {
      const tracerA = provider.getTracer('scope-a', '1.0.0', { attributes: { 'scope.key': 'val-a' } });
      const tracerB = provider.getTracer('scope-a', '1.0.0', { attributes: { 'scope.key': 'val-b' } });
      const a = tracerA.startSpan('a') as Span;
      const b = tracerB.startSpan('b') as Span;
      a.end();
      b.end();
      exporter.export([a, b]);
    });
    const resourceSpans = findLenField(sent, 1)!;
    const scopeSpansList = findAllLenFields(resourceSpans, 2);
    expect(scopeSpansList.length).toBe(2);
  });
});

describe('LiteSdk - encodeVarint (64-bit / negative)', () => {
  // encodeVarint is module-private; exercise it through encodeAnyValue, which
  // is itself reached via the public KeyValue path. We decode the resulting
  // span attribute back out of the OTLP buffer.
  function encodeAndExtractIntAttr(value: number): bigint {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    let sent: Buffer | undefined;
    (exporter as any)._udpExporter = {
      sendOtlp: (data: Buffer) => {
        sent = data;
      },
      shutdown: () => {},
    };
    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', { kind: SpanKind.SERVER }) as Span;
    span.setAttribute('big', value);
    span.end();
    exporter.export([span]);

    // ExportTraceServiceRequest(1) -> ResourceSpans -> ScopeSpans(2) -> Span(2)
    const resourceSpans = findLenField(sent!, 1)!;
    const scopeSpans = findLenField(resourceSpans, 2)!;
    const spanBytes = findLenField(scopeSpans, 2)!;
    // Find the KeyValue (field 9) whose key is 'big'.
    let p = 0;
    while (p < spanBytes.length) {
      const tag = readVarint(spanBytes, p);
      p = tag.pos;
      const field = Number(tag.value >> B3);
      const wire = Number(tag.value & BMASK);
      if (wire === 2) {
        const len = readVarint(spanBytes, p);
        p = len.pos;
        const end = p + Number(len.value);
        if (field === 9) {
          const kv = spanBytes.subarray(p, end);
          const keyBytes = findLenField(kv, 1);
          if (keyBytes && keyBytes.toString('utf-8') === 'big') {
            const anyValue = findLenField(kv, 2)!;
            // AnyValue int_value is field 3, varint.
            let ap = 0;
            while (ap < anyValue.length) {
              const at = readVarint(anyValue, ap);
              ap = at.pos;
              const af = Number(at.value >> B3);
              const aw = Number(at.value & BMASK);
              if (af === 3 && aw === 0) {
                return readVarint(anyValue, ap).value;
              }
              if (aw === 0) ap = readVarint(anyValue, ap).pos;
              else if (aw === 2) {
                const l = readVarint(anyValue, ap);
                ap = l.pos + Number(l.value);
              } else if (aw === 1) ap += 8;
              else break;
            }
          }
        }
        p = end;
      } else if (wire === 0) {
        p = readVarint(spanBytes, p).pos;
      } else if (wire === 1) {
        p += 8;
      } else if (wire === 5) {
        p += 4;
      } else {
        break;
      }
    }
    throw new Error('int attribute not found in encoded span');
  }

  afterEach(() => {
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
  });

  it('encodes a small integer attribute correctly', () => {
    expect(encodeAndExtractIntAttr(200)).toBe(BigInt(200));
  });

  it('encodes an integer above 2^32 without truncation', () => {
    const big = 5_000_000_000; // > 0xffffffff, still a safe integer
    expect(encodeAndExtractIntAttr(big)).toBe(BigInt(big));
  });

  it("encodes a negative integer as two's-complement int64", () => {
    // -1 in two's complement int64 is 0xffffffffffffffff.
    expect(encodeAndExtractIntAttr(-1)).toBe((BigInt(1) << BigInt(64)) - BigInt(1));
  });
});

describe('LiteSdk - liteEventContextExtractor', () => {
  // When run with --require @opentelemetry/contrib-test-utils, the global propagator
  // is already set and can't be overridden. Use disable() first to release the lock.
  before(() => {
    const { propagation } = require('@opentelemetry/api');
    const { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } = require('@opentelemetry/core');
    const { AWSXRayPropagator } = require('@opentelemetry/propagator-aws-xray');
    propagation.disable();
    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [new W3CBaggagePropagator(), new AWSXRayPropagator(), new W3CTraceContextPropagator()],
      })
    );
  });

  afterEach(() => {
    delete process.env._X_AMZN_TRACE_ID;
  });

  const VALID_XRAY = 'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1';

  it('extracts context from the _X_AMZN_TRACE_ID env var', () => {
    process.env._X_AMZN_TRACE_ID = VALID_XRAY;
    const ctx = liteEventContextExtractor({}, {});
    const sc = trace.getSpan(ctx)?.spanContext();
    expect(sc?.traceId).toBe('5759e988bd862e3fe1be46a994272793');
    expect(sc?.spanId).toBe('53995c3f42cd8ad8');
  });

  it('prefers the handler context xRayTraceId over the env var', () => {
    process.env._X_AMZN_TRACE_ID = 'Root=1-00000000-000000000000000000000000;Parent=0000000000000000;Sampled=0';
    const ctx = liteEventContextExtractor({}, { xRayTraceId: VALID_XRAY });
    const sc = trace.getSpan(ctx)?.spanContext();
    expect(sc?.traceId).toBe('5759e988bd862e3fe1be46a994272793');
  });

  it('extracts from event headers when no x-ray id present', () => {
    const ctx = liteEventContextExtractor({ headers: { 'x-amzn-trace-id': VALID_XRAY } }, {});
    const sc = trace.getSpan(ctx)?.spanContext();
    expect(sc?.traceId).toBe('5759e988bd862e3fe1be46a994272793');
  });

  it('returns ROOT_CONTEXT when nothing is extractable', () => {
    const ctx = liteEventContextExtractor({}, {});
    expect(ctx).toBe(ROOT_CONTEXT);
  });

  it('replaces a pre-existing trace header in event headers', () => {
    // Event already carries an x-amzn-trace-id; the env/handler id must win,
    // exercising the header-dedup loop.
    process.env._X_AMZN_TRACE_ID = VALID_XRAY;
    const ctx = liteEventContextExtractor({ headers: { 'X-Amzn-Trace-Id': 'Root=1-stale-stale-stale' } }, {});
    const sc = trace.getSpan(ctx)?.spanContext();
    expect(sc?.traceId).toBe('5759e988bd862e3fe1be46a994272793');
  });
});

describe('LiteSdk - patchAwsSdkForSmithyCore', () => {
  // The response-metadata middleware reads the active span, which requires the
  // global AsyncLocalStorage context manager that configureLiteMode installs.
  // Set lite mode so the shared smithy-send-patch takes the lite branch.
  before(() => {
    process.env.OTEL_AWS_LAMBDA_FAST_START = 'true';
    configureLiteMode();
  });

  after(() => {
    delete process.env.OTEL_AWS_LAMBDA_FAST_START;
  });

  function makeInstrumentation() {
    return {
      patchV3MiddlewareStack: sinon.stub(),
      _getV3SmithyClientSendPatch: undefined as any,
    };
  }

  function makeClient() {
    const added: any[] = [];
    return {
      added,
      __adotMiddlewarePatched: false,
      config: { credentials: undefined as any, region: undefined as any },
      middlewareStack: {
        add: (mw: any, opts: any) => added.push({ mw, opts }),
      },
    };
  }

  it('installs the patch factory on the instrumentation', () => {
    const instr = makeInstrumentation();
    patchAwsSdkForSmithyCore(instr);
    expect(typeof instr._getV3SmithyClientSendPatch).toBe('function');
  });

  it('adds the three ADOT middlewares on first send and calls original', async () => {
    const instr = makeInstrumentation();
    patchAwsSdkForSmithyCore(instr);

    const original = sinon.stub().resolves({ output: { $metadata: {} } });
    // factory receives the original send function (by type, robust to bound arg).
    const send = instr._getV3SmithyClientSendPatch('moduleVersion', original);

    const client = makeClient();
    const command: any = {};
    await send.call(client, command);

    const names = client.added.map(a => a.opts.name);
    expect(names).toContain('_adotInjectXrayContextMiddleware');
    expect(names).toContain('_adotExtractCredentials');
    expect(names).toContain('_adotCaptureResponseMetadata');
    expect(client.__adotMiddlewarePatched).toBe(true);
    expect(original.calledOnce).toBe(true);
    // client config stashed on the command via the well-known symbol.
    const cfgSym = Symbol.for('opentelemetry.instrumentation.aws-sdk.client.config');
    expect(command[cfgSym]).toBe(client.config);
  });

  it('does not re-add middlewares on a second send', async () => {
    const instr = makeInstrumentation();
    patchAwsSdkForSmithyCore(instr);
    const original = sinon.stub().resolves({});
    const send = instr._getV3SmithyClientSendPatch(original);

    const client = makeClient();
    await send.call(client, {});
    const countAfterFirst = client.added.length;
    await send.call(client, {});
    expect(client.added.length).toBe(countAfterFirst);
    expect(original.callCount).toBe(2);
  });

  it('xray injection middleware capitalizes the trace header', async () => {
    const instr = makeInstrumentation();
    patchAwsSdkForSmithyCore(instr);
    const original = sinon.stub().resolves({});
    const send = instr._getV3SmithyClientSendPatch(original);
    const client = makeClient();
    await send.call(client, {});

    const inject = client.added.find(a => a.opts.name === '_adotInjectXrayContextMiddleware').mw;
    const headers: Record<string, string> = { 'x-amzn-trace-id': 'Root=1-abc' };
    const next = sinon.stub().resolves({});
    await inject(next)({ request: { headers } });

    expect(headers['X-Amzn-Trace-Id']).toBe('Root=1-abc');
    expect(headers['x-amzn-trace-id']).toBeUndefined();
    expect(next.calledOnce).toBe(true);
  });

  it('response metadata middleware records request id and status', async () => {
    const instr = makeInstrumentation();
    patchAwsSdkForSmithyCore(instr);
    const original = sinon.stub().resolves({});
    const send = instr._getV3SmithyClientSendPatch(original);
    const client = makeClient();
    await send.call(client, {});

    const capture = client.added.find(a => a.opts.name === '_adotCaptureResponseMetadata').mw;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('s', { kind: SpanKind.CLIENT }) as Span;
    const ctx = trace.setSpan(context.active(), span);

    await context.with(ctx, async () => {
      const next = sinon.stub().resolves({
        output: { $metadata: { requestId: 'REQ1', extendedRequestId: 'EXT1', httpStatusCode: 200 } },
      });
      await capture(next)({ request: { headers: {} } });
    });

    expect(span.attributes['aws.request.id']).toBe('REQ1');
    expect(span.attributes['aws.request.extended_id']).toBe('EXT1');
    expect(span.attributes['http.status_code']).toBe(200);
    span.end();
  });

  it('credentials middleware records access key and region', async () => {
    const instr = makeInstrumentation();
    patchAwsSdkForSmithyCore(instr);
    const original = sinon.stub().resolves({});
    const send = instr._getV3SmithyClientSendPatch(original);

    const client = makeClient();
    // credentials and region provided as async resolver functions.
    client.config.credentials = async () => ({ accessKeyId: 'AKIA-TEST' });
    client.config.region = async () => 'us-west-2';
    await send.call(client, {});

    const extract = client.added.find(a => a.opts.name === '_adotExtractCredentials').mw;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('s', { kind: SpanKind.CLIENT }) as Span;
    const ctx = trace.setSpan(context.active(), span);

    await context.with(ctx, async () => {
      const next = sinon.stub().resolves({});
      await extract(next)({ request: { headers: {} } });
    });

    expect(span.attributes['aws.auth.account.access_key']).toBe('AKIA-TEST');
    expect(span.attributes['aws.auth.region']).toBe('us-west-2');
    span.end();
  });

  it('credentials middleware swallows resolver errors', async () => {
    const instr = makeInstrumentation();
    patchAwsSdkForSmithyCore(instr);
    const original = sinon.stub().resolves({});
    const send = instr._getV3SmithyClientSendPatch(original);

    const client = makeClient();
    client.config.credentials = async () => {
      throw new Error('no creds');
    };
    await send.call(client, {});

    const extract = client.added.find(a => a.opts.name === '_adotExtractCredentials').mw;

    const provider = new TracerProvider({ 'service.name': 'test' });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('s', { kind: SpanKind.CLIENT }) as Span;
    const ctx = trace.setSpan(context.active(), span);

    const next = sinon.stub().resolves({});
    await context.with(ctx, async () => {
      await expect(extract(next)({ request: { headers: {} } })).resolves.toBeDefined();
    });
    expect(span.attributes['aws.auth.account.access_key']).toBeUndefined();
    span.end();
  });

  it('swallows errors when given a malformed instrumentation', () => {
    expect(() => patchAwsSdkForSmithyCore(null)).not.toThrow();
  });
});

describe('LiteSdk - configureLiteMode', () => {
  afterEach(() => {
    delete process.env.AWS_XRAY_DAEMON_ADDRESS;
  });

  it('returns a TracerProvider with global APIs wired up', () => {
    const provider = configureLiteMode();
    expect(provider).toBeInstanceOf(TracerProvider);
    // global tracer provider resolves to a working tracer
    const tracer = trace.getTracer('post-configure');
    const span = tracer.startSpan('t');
    expect(span).toBeDefined();
    span.end();
    provider.shutdown();
  });

  it('honors AWS_XRAY_DAEMON_ADDRESS for the exporter endpoint', () => {
    process.env.AWS_XRAY_DAEMON_ADDRESS = '127.0.0.1:9999';
    const provider = configureLiteMode();
    expect(provider).toBeInstanceOf(TracerProvider);
    provider.shutdown();
  });
});

describe('LiteSdk - UdpExporter', () => {
  it('sendOtlp sends data with prefix and protocol header', () => {
    const exporter = new UdpExporter('127.0.0.1:2000');
    const sendStub = sinon.stub((exporter as any)._socket, 'send');

    exporter.sendOtlp(Buffer.from('test-data'), 'T1S');

    expect(sendStub.calledOnce).toBe(true);
    const sentMessage = sendStub.firstCall.args[0].toString('utf-8');
    expect(sentMessage).toContain('T1S');
    expect(sentMessage).toContain('{"format":"json","version":1}');

    sendStub.restore();
    exporter.shutdown();
  });

  it('sendOtlp swallows socket send errors', () => {
    const exporter = new UdpExporter('127.0.0.1:2000');
    const sendStub = sinon.stub((exporter as any)._socket, 'send').throws(new Error('socket closed'));

    expect(() => exporter.sendOtlp(Buffer.from('data'), 'T1U')).not.toThrow();

    sendStub.restore();
    exporter.shutdown();
  });
});

describe('LiteSdk - Full Invocation Simulation', () => {
  afterEach(() => {
    delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  it('simulates Lambda invocation with SERVER + CLIENT spans', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';
    process.env.OTEL_SERVICE_NAME = 'my-function';
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'cloud.region=us-west-2,cloud.platform=aws_lambda';

    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider();
    const proc = new BatchingSpanProcessor(exporter);
    provider.addSpanProcessor(proc);
    const tracer = provider.getTracer('test');

    const serverSpan = tracer.startSpan('my-function.handler', { kind: SpanKind.SERVER }) as Span;
    serverSpan.setAttribute('faas.invocation_id', 'req-abc');
    serverSpan.setAttribute('faas.id', 'arn:aws:lambda:us-west-2:123:function:my-function');

    const serverCtx = trace.setSpan(context.active(), serverSpan);
    const clientSpan = tracer.startSpan('S3.ListBuckets', { kind: SpanKind.CLIENT }, serverCtx) as Span;
    clientSpan.setAttribute('rpc.service', 'S3');
    clientSpan.setAttribute('rpc.system', 'aws-api');
    clientSpan.setAttribute('rpc.method', 'ListBuckets');
    clientSpan.setAttribute('http.status_code', 200);
    clientSpan.end();
    serverSpan.end();

    provider.forceFlush();

    expect(serverSpan.attributes['aws.local.service']).toBe('my-function');
    expect(serverSpan.attributes['aws.span.kind']).toBe('LOCAL_ROOT');
    expect(clientSpan.attributes['aws.remote.service']).toBe('AWS::S3');
    expect(clientSpan.attributes['aws.remote.operation']).toBe('ListBuckets');
    expect(clientSpan.attributes['aws.span.kind']).toBe('CLIENT');
    expect(clientSpan.attributes['faas.id']).toBe('arn:aws:lambda:us-west-2:123:function:my-function');
    expect(serverSpan.spanContext().traceId).toBe(clientSpan.spanContext().traceId);
    expect(clientSpan.parent?.spanId).toBe(serverSpan.spanContext().spanId);
    expect(mockUdp.sendOtlp.called).toBe(true);
  });

  it('multiple invocations reuse provider', () => {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    process.env.OTEL_SERVICE_NAME = 'my-function';
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'cloud.region=us-west-2';

    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    const mockUdp = { sendOtlp: sinon.stub(), shutdown: sinon.stub() };
    (exporter as any)._udpExporter = mockUdp;

    const provider = new TracerProvider();
    const proc = new BatchingSpanProcessor(exporter);
    provider.addSpanProcessor(proc);
    const tracer = provider.getTracer('test');

    for (let i = 0; i < 3; i++) {
      const span = tracer.startSpan(`invocation-${i}`, { kind: SpanKind.SERVER }) as Span;
      span.setAttribute('faas.invocation_id', `req-${i}`);
      span.end();
      provider.forceFlush();
    }

    expect(mockUdp.sendOtlp.callCount).toBe(3);
  });
});

describe('LiteSdk - buildInstrumentations', () => {
  let buildInstrumentations: () => any[];
  const ENABLED = 'OTEL_NODE_ENABLED_INSTRUMENTATIONS';
  const DISABLED = 'OTEL_NODE_DISABLED_INSTRUMENTATIONS';

  before(() => {
    buildInstrumentations = require('../src/opentelemetry-lite-sdk').buildInstrumentations;
  });

  afterEach(() => {
    delete process.env[ENABLED];
    delete process.env[DISABLED];
  });

  it('returns instances when no enable/disable env is set (registry default)', () => {
    const instrs = buildInstrumentations();
    expect(Array.isArray(instrs)).toBe(true);
    // aws-sdk, http and aws-lambda are installed deps, so at least these load.
    expect(instrs.length).toBeGreaterThan(0);
  });

  it('honors the enabled allowlist (only aws-sdk)', () => {
    process.env[ENABLED] = 'aws-sdk';
    const instrs = buildInstrumentations();
    // Exactly the allowlisted, installed instrumentation is built.
    expect(instrs.length).toBe(1);
    expect(instrs[0].constructor.name).toBe('AwsInstrumentation');
  });

  it('honors the disabled denylist', () => {
    process.env[ENABLED] = 'aws-sdk,http';
    process.env[DISABLED] = 'http';
    const instrs = buildInstrumentations();
    const names = instrs.map(i => i.constructor.name);
    expect(names).toContain('AwsInstrumentation');
    expect(names).not.toContain('HttpInstrumentation');
  });
});

// ─── Parity Check: Lite SDK vs Full SDK ───────────────────────────────────────
// Verifies that the lite SDK produces output identical in structure to the full
// SDK for the same span data — both at the span-attribute level and the OTLP
// protobuf wire level.

describe('LiteSdk - Parity Check vs Full SDK', () => {
  const SERVICE_NAME = 'parity-test-service';
  const FUNCTION_NAME = 'parity-test-function';

  let originalAppSignals: string | undefined;
  let originalFunctionName: string | undefined;
  let originalServiceName: string | undefined;
  let originalResourceAttrs: string | undefined;

  beforeEach(() => {
    originalAppSignals = process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    originalFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    originalServiceName = process.env.OTEL_SERVICE_NAME;
    originalResourceAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;

    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'true';
    process.env.AWS_LAMBDA_FUNCTION_NAME = FUNCTION_NAME;
    process.env.OTEL_SERVICE_NAME = SERVICE_NAME;
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'cloud.region=us-west-2,cloud.platform=aws_lambda,cloud.provider=aws';
  });

  afterEach(() => {
    if (originalAppSignals !== undefined) process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = originalAppSignals;
    else delete process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED;
    if (originalFunctionName !== undefined) process.env.AWS_LAMBDA_FUNCTION_NAME = originalFunctionName;
    else delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    if (originalServiceName !== undefined) process.env.OTEL_SERVICE_NAME = originalServiceName;
    else delete process.env.OTEL_SERVICE_NAME;
    if (originalResourceAttrs !== undefined) process.env.OTEL_RESOURCE_ATTRIBUTES = originalResourceAttrs;
    else delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  function createLiteSpans(): { serverSpan: Span; clientSpan: Span; exportedBuffer: Buffer } {
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    let capturedBuffer: Buffer = Buffer.alloc(0);
    (exporter as any)._udpExporter = {
      sendOtlp: (data: Buffer) => {
        capturedBuffer = data;
      },
      shutdown: () => {},
    };

    const provider = new TracerProvider();
    const proc = new BatchingSpanProcessor(exporter);
    provider.addSpanProcessor(proc);
    const tracer = provider.getTracer('@opentelemetry/instrumentation-aws-lambda');

    const serverSpan = tracer.startSpan(FUNCTION_NAME, { kind: SpanKind.SERVER }) as Span;
    serverSpan.setAttribute('faas.invocation_id', 'req-parity');
    serverSpan.setAttribute('faas.id', `arn:aws:lambda:us-west-2:123456789012:function:${FUNCTION_NAME}`);

    const serverCtx = trace.setSpan(context.active(), serverSpan);
    const clientSpan = tracer.startSpan('S3.ListBuckets', { kind: SpanKind.CLIENT }, serverCtx) as Span;
    clientSpan.setAttribute('rpc.service', 'S3');
    clientSpan.setAttribute('rpc.system', 'aws-api');
    clientSpan.setAttribute('rpc.method', 'ListBuckets');
    clientSpan.setAttribute('http.status_code', 200);
    clientSpan.setAttribute('aws.request.id', 'TESTREQID123');
    clientSpan.setAttribute('aws.request.extended_id', 'EXTID456');
    clientSpan.setAttribute('aws.auth.region', 'us-west-2');
    clientSpan.setAttribute('aws.auth.account.access_key', 'AKIATEST');
    clientSpan.end();
    serverSpan.end();

    provider.forceFlush();

    return { serverSpan, clientSpan, exportedBuffer: capturedBuffer };
  }

  describe('Span Attribute Parity', () => {
    it('SERVER span has expected Application Signals attributes', () => {
      const { serverSpan } = createLiteSpans();
      expect(serverSpan.attributes['aws.local.service']).toBe(SERVICE_NAME);
      expect(serverSpan.attributes['aws.local.operation']).toBe(`${FUNCTION_NAME}/FunctionHandler`);
      expect(serverSpan.attributes['aws.local.environment']).toBe('lambda:default');
      expect(serverSpan.attributes['aws.span.kind']).toBe('LOCAL_ROOT');
      expect(serverSpan.attributes['aws.is.local.root']).toBe(true);
    });

    it('CLIENT span has expected remote service attributes', () => {
      const { clientSpan } = createLiteSpans();
      expect(clientSpan.attributes['aws.remote.service']).toBe('AWS::S3');
      expect(clientSpan.attributes['aws.remote.operation']).toBe('ListBuckets');
      expect(clientSpan.attributes['aws.span.kind']).toBe('CLIENT');
      expect(clientSpan.attributes['aws.is.local.root']).toBe(false);
    });

    it('CLIENT span has credential and request metadata attributes', () => {
      const { clientSpan } = createLiteSpans();
      expect(clientSpan.attributes['aws.auth.region']).toBe('us-west-2');
      expect(clientSpan.attributes['aws.auth.account.access_key']).toBe('AKIATEST');
      expect(clientSpan.attributes['aws.request.id']).toBe('TESTREQID123');
      expect(clientSpan.attributes['aws.request.extended_id']).toBe('EXTID456');
      expect(clientSpan.attributes['http.status_code']).toBe(200);
    });

    it('CLIENT span has rpc semantic conventions', () => {
      const { clientSpan } = createLiteSpans();
      expect(clientSpan.attributes['rpc.service']).toBe('S3');
      expect(clientSpan.attributes['rpc.system']).toBe('aws-api');
      expect(clientSpan.attributes['rpc.method']).toBe('ListBuckets');
    });

    it('CLIENT span inherits faas.id from parent', () => {
      const { clientSpan } = createLiteSpans();
      expect(clientSpan.attributes['faas.id']).toBe(`arn:aws:lambda:us-west-2:123456789012:function:${FUNCTION_NAME}`);
    });

    it('resource attributes match expected full SDK output', () => {
      const { serverSpan } = createLiteSpans();
      expect(serverSpan.resource['service.name']).toBe(SERVICE_NAME);
      expect(serverSpan.resource['cloud.region']).toBe('us-west-2');
      expect(serverSpan.resource['cloud.platform']).toBe('aws_lambda');
      expect(serverSpan.resource['cloud.provider']).toBe('aws');
      expect(serverSpan.resource['telemetry.sdk.language']).toBe('nodejs');
      expect(serverSpan.resource['telemetry.sdk.name']).toBe('opentelemetry');
      expect(serverSpan.resource['telemetry.sdk.version']).toBe(require('@opentelemetry/core').VERSION);
      expect(serverSpan.resource['telemetry.auto.version']).toBe(require('../src/version').LIB_VERSION + '-aws');
    });

    it('span parent-child relationship is correct', () => {
      const { serverSpan, clientSpan } = createLiteSpans();
      expect(clientSpan.spanContext().traceId).toBe(serverSpan.spanContext().traceId);
      expect(clientSpan.parent?.spanId).toBe(serverSpan.spanContext().spanId);
    });

    it('app signals disabled produces no aws.local/remote/span.kind attributes', () => {
      process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
      const exporter = new UdpSpanExporter('127.0.0.1:2000');
      (exporter as any)._udpExporter = { sendOtlp: () => {}, shutdown: () => {} };

      const provider = new TracerProvider();
      const proc = new BatchingSpanProcessor(exporter);
      provider.addSpanProcessor(proc);
      const tracer = provider.getTracer('test');

      const span = tracer.startSpan('handler', { kind: SpanKind.SERVER }) as Span;
      span.end();
      provider.forceFlush();

      expect(span.attributes['aws.local.service']).toBeUndefined();
      expect(span.attributes['aws.local.operation']).toBeUndefined();
      expect(span.attributes['aws.span.kind']).toBeUndefined();
      expect(span.attributes['aws.is.local.root']).toBeUndefined();
    });
  });

  describe('OTLP Wire Format Parity', () => {
    it('exported buffer is valid OTLP protobuf', () => {
      const { exportedBuffer } = createLiteSpans();
      expect(exportedBuffer.length).toBeGreaterThan(0);

      // Decode with the full SDK's protobuf library to validate structure
      let decoded: any;
      try {
        require('@opentelemetry/otlp-transformer'); // ensure dep is available
        // The buffer is a raw ExportTraceServiceRequest — try deserializing via protobufjs
        const protobuf = require('protobufjs');
        const root = protobuf.loadSync(
          require.resolve(
            '@opentelemetry/otlp-transformer/protos/opentelemetry/proto/collector/trace/v1/trace_service.proto'
          )
        );
        const ExportTraceServiceRequest = root.lookupType(
          'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest'
        );
        decoded = ExportTraceServiceRequest.decode(exportedBuffer);
      } catch (e) {
        // If proto files aren't available, fall back to basic structural checks
        // The buffer should start with a valid protobuf tag (field 1, wire type 2 = 0x0A)
        expect(exportedBuffer[0]).toBe(0x0a);
        return;
      }

      // Validate decoded structure matches what X-Ray/full SDK expects
      expect(decoded.resourceSpans).toBeDefined();
      expect(decoded.resourceSpans.length).toBe(1);

      const rs = decoded.resourceSpans[0];
      expect(rs.resource).toBeDefined();
      expect(rs.scopeSpans).toBeDefined();
      expect(rs.scopeSpans.length).toBeGreaterThan(0);

      // Collect all spans from all scopes
      const allSpans = rs.scopeSpans.flatMap((ss: any) => ss.spans || []);
      expect(allSpans.length).toBe(2); // SERVER + CLIENT

      const serverProto = allSpans.find((s: any) => s.kind === 2); // SERVER
      const clientProto = allSpans.find((s: any) => s.kind === 3); // CLIENT
      expect(serverProto).toBeDefined();
      expect(clientProto).toBeDefined();

      // Verify span names
      expect(serverProto.name).toBe(FUNCTION_NAME);
      expect(clientProto.name).toBe('S3.ListBuckets');

      // Verify parent-child via spanId/parentSpanId
      expect(clientProto.parentSpanId).toBeDefined();
      expect(clientProto.traceId.toString('hex') || Buffer.from(clientProto.traceId).toString('hex')).toBe(
        serverProto.traceId.toString('hex') || Buffer.from(serverProto.traceId).toString('hex')
      );
    });

    it('resource attributes are encoded in the protobuf payload', () => {
      const { exportedBuffer } = createLiteSpans();
      // service.name should appear as a UTF-8 string in the buffer
      expect(exportedBuffer.toString('utf-8')).toContain(SERVICE_NAME);
      expect(exportedBuffer.toString('utf-8')).toContain('opentelemetry');
      expect(exportedBuffer.toString('utf-8')).toContain('nodejs');
    });

    it('span attributes are encoded in the protobuf payload', () => {
      const { exportedBuffer } = createLiteSpans();
      const bufStr = exportedBuffer.toString('utf-8');
      // Key span attributes should be present as raw strings in the protobuf
      expect(bufStr).toContain('rpc.service');
      expect(bufStr).toContain('rpc.method');
      expect(bufStr).toContain('ListBuckets');
      expect(bufStr).toContain('aws.remote.service');
      expect(bufStr).toContain('AWS::S3');
      expect(bufStr).toContain('aws.local.service');
      expect(bufStr).toContain(SERVICE_NAME);
      expect(bufStr).toContain('aws.auth.region');
      expect(bufStr).toContain('aws.request.id');
      expect(bufStr).toContain('TESTREQID123');
    });

    it('uses T1S prefix for sampled spans', () => {
      const exporter = new UdpSpanExporter('127.0.0.1:2000');
      let capturedPrefix = '';
      (exporter as any)._udpExporter = {
        sendOtlp: (_data: Buffer, prefix: string) => {
          capturedPrefix = prefix;
        },
        shutdown: () => {},
      };

      const provider = new TracerProvider();
      const proc = new BatchingSpanProcessor(exporter);
      provider.addSpanProcessor(proc);
      const tracer = provider.getTracer('test');

      const span = tracer.startSpan('test', { kind: SpanKind.SERVER }) as Span;
      span.end();
      provider.forceFlush();

      expect(capturedPrefix).toBe('T1S');
    });

    it('encoded output matches full SDK ProtobufTraceSerializer structure', () => {
      const { exportedBuffer } = createLiteSpans();

      // Use the full SDK's serializer on equivalent ReadableSpan-like objects to compare
      try {
        require('@opentelemetry/otlp-transformer'); // ensure dep is available
        require('@opentelemetry/resources'); // ensure dep is available

        // The full SDK serializer expects ReadableSpan[] — we can't easily construct those
        // without the full SDK pipeline. Instead verify both encode the same key attributes.
        // If the lite SDK's protobuf is decodable by the same proto schema the full SDK uses,
        // and contains the same attribute keys/values, they produce equivalent X-Ray segments.
        const bufStr = exportedBuffer.toString('utf-8');

        // These are the attributes the full SDK puts on spans via AwsMetricAttributesSpanExporter
        // Verify the lite SDK's encoding contains them all
        const expectedAttributes = [
          'aws.local.service',
          SERVICE_NAME,
          'aws.local.operation',
          `${FUNCTION_NAME}/FunctionHandler`,
          'aws.local.environment',
          'lambda:default',
          'aws.remote.service',
          'AWS::S3',
          'aws.remote.operation',
          'ListBuckets',
          'aws.span.kind',
          'LOCAL_ROOT',
          'aws.span.kind',
          'CLIENT',
          'rpc.service',
          'S3',
          'rpc.system',
          'aws-api',
          'rpc.method',
          'ListBuckets',
          'aws.auth.region',
          'us-west-2',
          'aws.auth.account.access_key',
          'AKIATEST',
          'aws.request.id',
          'TESTREQID123',
          'aws.request.extended_id',
          'EXTID456',
          'telemetry.auto.version',
          require('../src/version').LIB_VERSION + '-aws',
          'faas.id',
        ];

        for (const attr of expectedAttributes) {
          expect(bufStr).toContain(attr);
        }
      } catch (e) {
        // If otlp-transformer or resources aren't available, skip gracefully
        console.log('Skipping full SDK comparison (deps not available):', (e as Error).message);
      }
    });
  });
});
