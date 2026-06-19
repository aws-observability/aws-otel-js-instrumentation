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
  patchAwsSdkForSmithyCore,
  Span,
  TracerProvider,
  UdpExporter,
  UdpSpanExporter,
} from '../src/opentelemetry_lite_sdk';

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
    expect(provider.resource['telemetry.sdk.version']).toBe('2.7.0');
    expect(provider.resource['telemetry.auto.version']).toBe('0.11.0-dev0-aws');
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
      sendOtlp: (data: Buffer) => { sentBuffers.push(data); },
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
      sendOtlp: (data: Buffer) => { sentBuffers.push(data); },
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
      sendOtlp: (data: Buffer) => { sentBuffers.push(data); },
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
      sendOtlp: (data: Buffer) => { sentBuffers.push(data); },
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
      sendOtlp: () => { throw new Error('udp down'); },
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
      sendOtlp: (data: Buffer) => { sentBuffers.push(data); },
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

describe('LiteSdk - encodeVarint (64-bit / negative)', () => {
  // encodeVarint is module-private; exercise it through encodeAnyValue, which
  // is itself reached via the public KeyValue path. We decode the resulting
  // span attribute back out of the OTLP buffer.
  function encodeAndExtractIntAttr(value: number): bigint {
    process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    const exporter = new UdpSpanExporter('127.0.0.1:2000');
    let sent: Buffer | undefined;
    (exporter as any)._udpExporter = {
      sendOtlp: (data: Buffer) => { sent = data; },
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
              else if (aw === 2) { const l = readVarint(anyValue, ap); ap = l.pos + Number(l.value); }
              else if (aw === 1) ap += 8;
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

  it('encodes a negative integer as two\'s-complement int64', () => {
    // -1 in two's complement int64 is 0xffffffffffffffff.
    expect(encodeAndExtractIntAttr(-1)).toBe((BigInt(1) << BigInt(64)) - BigInt(1));
  });
});

describe('LiteSdk - liteEventContextExtractor', () => {
  // Extraction relies on the global X-Ray propagator that configureLiteMode installs.
  before(() => {
    configureLiteMode();
  });

  afterEach(() => {
    delete process.env._X_AMZN_TRACE_ID;
  });

  const VALID_XRAY =
    'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1';

  it('extracts context from the _X_AMZN_TRACE_ID env var', () => {
    process.env._X_AMZN_TRACE_ID = VALID_XRAY;
    const ctx = liteEventContextExtractor({}, {});
    const sc = trace.getSpan(ctx)?.spanContext();
    expect(sc?.traceId).toBe('5759e988bd862e3fe1be46a994272793');
    expect(sc?.spanId).toBe('53995c3f42cd8ad8');
  });

  it('prefers the handler context xRayTraceId over the env var', () => {
    process.env._X_AMZN_TRACE_ID =
      'Root=1-00000000-000000000000000000000000;Parent=0000000000000000;Sampled=0';
    const ctx = liteEventContextExtractor({}, { xRayTraceId: VALID_XRAY });
    const sc = trace.getSpan(ctx)?.spanContext();
    expect(sc?.traceId).toBe('5759e988bd862e3fe1be46a994272793');
  });

  it('extracts from event headers when no x-ray id present', () => {
    const ctx = liteEventContextExtractor(
      { headers: { 'x-amzn-trace-id': VALID_XRAY } },
      {}
    );
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
    const ctx = liteEventContextExtractor(
      { headers: { 'X-Amzn-Trace-Id': 'Root=1-stale-stale-stale' } },
      {}
    );
    const sc = trace.getSpan(ctx)?.spanContext();
    expect(sc?.traceId).toBe('5759e988bd862e3fe1be46a994272793');
  });
});

describe('LiteSdk - patchAwsSdkForSmithyCore', () => {
  // The response-metadata middleware reads the active span, which requires the
  // global AsyncLocalStorage context manager that configureLiteMode installs.
  before(() => {
    configureLiteMode();
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

    const inject = client.added.find(
      a => a.opts.name === '_adotInjectXrayContextMiddleware'
    ).mw;
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

    const capture = client.added.find(
      a => a.opts.name === '_adotCaptureResponseMetadata'
    ).mw;

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

    const extract = client.added.find(
      a => a.opts.name === '_adotExtractCredentials'
    ).mw;

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
    client.config.credentials = async () => { throw new Error('no creds'); };
    await send.call(client, {});

    const extract = client.added.find(
      a => a.opts.name === '_adotExtractCredentials'
    ).mw;

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
    const sendStub = sinon
      .stub((exporter as any)._socket, 'send')
      .throws(new Error('socket closed'));

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
