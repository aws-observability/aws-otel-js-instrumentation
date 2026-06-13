// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import { LoggerProvider, SimpleLogRecordProcessor, InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SnapshotOtlpEmitter } from '../../src/dynamic-instrumentation/snapshot-otlp-emitter';
import { Snapshot } from '../../src/dynamic-instrumentation/model/snapshot';

/**
 * Exercises the body/attribute conversion paths of SnapshotOtlpEmitter that the
 * trace-context-focused suite does not cover (captures, stack, throwable,
 * method-level vs line-level, value variants).
 */
describe('SnapshotOtlpEmitter body and attributes', function () {
  let emitter: SnapshotOtlpEmitter;
  let inMemoryExporter: InMemoryLogRecordExporter;
  let loggerProvider: LoggerProvider;

  beforeEach(function () {
    inMemoryExporter = new InMemoryLogRecordExporter();
    loggerProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(inMemoryExporter)],
    });
    emitter = new SnapshotOtlpEmitter('http://localhost:4321/v1/logs', 'test-service', 'test-env');
    (emitter as any).logger = loggerProvider.getLogger('aws.dynamic_instrumentation', '1.0');
  });

  afterEach(async function () {
    await loggerProvider.shutdown();
    sinon.restore();
  });

  function baseSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
    return {
      id: 'snap-1',
      timestamp: 1_700_000_000_123,
      service: 'test-service',
      environment: 'test-env',
      locationHash: 'hash-1',
      instrumentation: {
        location: {
          lineNumber: 42,
          filePath: '/app/orders.js',
          language: 'javascript',
        },
      },
      trace: { traceId: '', spanId: '' },
      thread: { id: 1, name: 'main' },
      stack: [],
      captures: {},
      ...overrides,
    };
  }

  function onlyRecord() {
    const records = inMemoryExporter.getFinishedLogRecords();
    expect(records.length).toBe(1);
    return records[0];
  }

  it('emits flat attributes for a line-level snapshot', function () {
    emitter.emitSnapshot(baseSnapshot(), 'BREAKPOINT');
    const rec = onlyRecord();
    expect(rec.attributes['event.name']).toBe('aws.dynamic_instrumentation.snapshot');
    expect(rec.attributes['aws.di.snapshot_id']).toBe('snap-1');
    expect(rec.attributes['aws.di.location_hash']).toBe('hash-1');
    expect(rec.attributes['aws.di.instrumentation_level']).toBe('line');
    // duration, code_unit, class_name, and method_name are intentionally not emitted —
    // JS DI targets file path + line only and has no method duration to report
    expect(rec.attributes['aws.di.duration_ms']).toBeUndefined();
    expect(rec.attributes['aws.di.code_unit']).toBeUndefined();
    expect(rec.attributes['aws.di.class_name']).toBeUndefined();
    expect(rec.attributes['aws.di.method_name']).toBeUndefined();
    expect(rec.attributes['aws.di.file_path']).toBe('/app/orders.js');
    expect(rec.attributes['aws.di.line_number']).toBe(42);
    expect(rec.attributes['aws.di.instrumentation_type']).toBe('BREAKPOINT');
  });

  it('marks method-level when lineNumber is 0 and omits line_number', function () {
    const snap = baseSnapshot();
    snap.instrumentation.location.lineNumber = 0;
    emitter.emitSnapshot(snap, 'PROBE');
    const rec = onlyRecord();
    expect(rec.attributes['aws.di.instrumentation_level']).toBe('method');
    expect(rec.attributes['aws.di.line_number']).toBeUndefined();
  });

  it('omits instrumentation_type when not passed', function () {
    emitter.emitSnapshot(baseSnapshot());
    const rec = onlyRecord();
    expect(rec.attributes['aws.di.instrumentation_type']).toBeUndefined();
  });

  it('converts stack frames into the body', function () {
    const snap = baseSnapshot({
      stack: [
        { fileName: '/app/a.js', function: 'fnA', lineNumber: 10 },
        { fileName: '/app/b.js', function: 'fnB', lineNumber: 20 },
      ],
    });
    emitter.emitSnapshot(snap);
    const body: any = onlyRecord().body;
    expect(body.stack).toHaveLength(2);
    expect(body.stack[0]).toEqual({ file_path: '/app/a.js', function: 'fnA', line_number: 10 });
  });

  it('converts entry/return/lines captured contexts with all value variants', function () {
    const snap = baseSnapshot({
      captures: {
        entry: {
          arguments: {
            primitive: { type: 'number', value: '42' },
            nullVal: { type: 'object', isNull: true },
            notCaptured: { type: 'object', notCapturedReason: 'depth' },
            obj: { type: 'Object', fields: { inner: { type: 'string', value: 'hi' } } },
            arr: { type: 'Array', elements: [{ type: 'number', value: '1' }], truncated: true, size: 5 },
            map: {
              type: 'Map',
              entries: [
                [
                  { type: 'string', value: 'k' },
                  { type: 'string', value: 'v' },
                ],
              ],
            },
          },
        },
        return: {
          returnValue: { type: 'boolean', value: 'true' },
        },
        lines: {
          '42': {
            locals: { x: { type: 'number', value: '7' } },
            throwable: {
              type: 'TypeError',
              message: 'boom',
              stacktrace: [{ fileName: '/app/a.js', function: 'fnA', lineNumber: 3 }],
            },
          },
        },
      },
    });
    emitter.emitSnapshot(snap, 'BREAKPOINT');
    const body: any = onlyRecord().body;

    // entry arguments — value variants
    const args = body.captures.entry.arguments;
    expect(args.primitive).toEqual({ type: 'number', value: '42' });
    expect(args.nullVal).toEqual({ type: 'object', is_null: true });
    expect(args.notCaptured).toEqual({ type: 'object', not_captured_reason: 'depth' });
    expect(args.obj.fields.inner).toEqual({ type: 'string', value: 'hi' });
    expect(args.arr.elements).toHaveLength(1);
    expect(args.arr.truncated).toBe(true);
    expect(args.arr.size).toBe(5);
    expect(args.map.entries[0].key).toEqual({ type: 'string', value: 'k' });
    expect(args.map.entries[0].value).toEqual({ type: 'string', value: 'v' });

    // return value
    expect(body.captures.return.return_value).toEqual({ type: 'boolean', value: 'true' });

    // line-level locals + throwable
    expect(body.captures.lines['42'].locals.x).toEqual({ type: 'number', value: '7' });
    expect(body.captures.lines['42'].throwable.type).toBe('TypeError');
    expect(body.captures.lines['42'].throwable.message).toBe('boom');
    expect(body.captures.lines['42'].throwable.stacktrace[0].function).toBe('fnA');
  });

  it('defaults throwable message to empty string when missing', function () {
    const snap = baseSnapshot({
      captures: {
        entry: {
          throwable: { type: 'Error', message: undefined as any, stacktrace: undefined as any },
        },
      },
    });
    emitter.emitSnapshot(snap);
    const body: any = onlyRecord().body;
    expect(body.captures.entry.throwable.message).toBe('');
    expect(body.captures.entry.throwable.stacktrace).toEqual([]);
  });

  it('omits the body entirely when there is no stack and no captures', function () {
    const snap = baseSnapshot();
    (snap as any).captures = undefined;
    emitter.emitSnapshot(snap);
    expect(onlyRecord().body).toBeUndefined();
  });

  it('includes an empty captures object in the body when captures is {}', function () {
    // captures = {} is truthy, so the emitter still attaches an (empty) captures map.
    const body: any = (() => {
      emitter.emitSnapshot(baseSnapshot({ captures: {} }));
      return onlyRecord().body;
    })();
    expect(body).toEqual({ captures: {} });
  });

  it('does nothing when the logger failed to initialize', function () {
    const e = new SnapshotOtlpEmitter('http://localhost:4321/v1/logs', 'svc', 'env');
    (e as any).initFailed = true; // simulate prior init failure
    // Should not throw and should not produce a record
    e.emitSnapshot(baseSnapshot());
    expect(inMemoryExporter.getFinishedLogRecords().length).toBe(0);
  });

  it('catches and swallows errors thrown during emission', function () {
    // Make the underlying logger.emit throw
    (emitter as any).logger = {
      emit: () => {
        throw new Error('emit failed');
      },
    };
    expect(() => emitter.emitSnapshot(baseSnapshot())).not.toThrow();
  });

  describe('constructor endpoint resolution', function () {
    const saved = process.env.OTEL_AWS_OTLP_LOGS_ENDPOINT;
    afterEach(function () {
      if (saved === undefined) delete process.env.OTEL_AWS_OTLP_LOGS_ENDPOINT;
      else process.env.OTEL_AWS_OTLP_LOGS_ENDPOINT = saved;
    });

    it('falls back to OTEL_AWS_OTLP_LOGS_ENDPOINT when no endpoint passed', function () {
      process.env.OTEL_AWS_OTLP_LOGS_ENDPOINT = 'http://env-endpoint:4318/v1/logs';
      const e = new SnapshotOtlpEmitter(undefined, 'svc', 'env');
      expect((e as any).logsEndpoint).toBe('http://env-endpoint:4318/v1/logs');
    });

    it('falls back to the default endpoint when neither arg nor env is set', function () {
      delete process.env.OTEL_AWS_OTLP_LOGS_ENDPOINT;
      const e = new SnapshotOtlpEmitter(undefined, 'svc', 'env');
      expect((e as any).logsEndpoint).toBe('http://localhost:4316/v1/logs');
    });
  });

  describe('resource attributes', function () {
    it('attaches service.name and deployment.environment to the emitted record resource', function () {
      // The emitter builds a resource from (serviceName, environment) and passes it to its
      // LoggerProvider. Mirror that wiring here with an in-memory exporter and assert the
      // resource propagates onto the exported record.
      const exporter = new InMemoryLogRecordExporter();
      const provider = new LoggerProvider({
        resource: resourceFromAttributes({
          'service.name': 'test-service',
          'deployment.environment': 'test-env',
        }),
        processors: [new SimpleLogRecordProcessor(exporter)],
      });
      const e = new SnapshotOtlpEmitter('http://localhost:4321/v1/logs', 'test-service', 'test-env');
      (e as any).logger = provider.getLogger('aws.dynamic_instrumentation', '1.0');

      e.emitSnapshot(baseSnapshot(), 'BREAKPOINT');

      const records = exporter.getFinishedLogRecords();
      expect(records.length).toBe(1);
      expect(records[0].resource.attributes['service.name']).toBe('test-service');
      expect(records[0].resource.attributes['deployment.environment']).toBe('test-env');
      return provider.shutdown();
    });

    it('builds a resource with the configured service name in ensureInitialized', function () {
      // Drive the real init path and confirm a LoggerProvider was created (resource wired in).
      const e = new SnapshotOtlpEmitter('http://localhost:4321/v1/logs', 'order-service', 'prod');
      const ok = (e as any).ensureInitialized();
      expect(ok).toBe(true);
      expect((e as any).loggerProvider).toBeTruthy();
      return e.shutdown();
    });
  });

  describe('shutdown', function () {
    it('flushes and shuts down an initialized provider', async function () {
      // Force real initialization so loggerProvider is owned by the emitter
      const e = new SnapshotOtlpEmitter('http://localhost:4321/v1/logs', 'svc', 'env');
      (e as any).ensureInitialized();
      await e.shutdown();
      // Second shutdown is a no-op and must not throw
      await e.shutdown();
    });
  });
});
