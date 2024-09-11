// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import { diag, ROOT_CONTEXT } from '@opentelemetry/api';
import { ExportResult, ExportResultCode, loggingErrorHandler, setGlobalErrorHandler } from '@opentelemetry/core';
import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  Span,
  SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { Resource, ResourceAttributes } from '@opentelemetry/resources';
import { AwsBatchUnsampledSpanProcessor } from '../src/aws-batch-unsampled-span-processor';
import { AlwaysRecordSampler } from '../src/always-record-sampler';

/**
 * This test file is a modified version of `BatchSpanProcessorBase.test.ts`.
 * It is designed to test the custom behavior of the `AwsBatchUnsampledSpanProcessor`,
 * specifically focusing on the modifications made to handle unsampled spans.
 */

function createSampledSpan(spanName: string): Span {
  const tracer = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
  }).getTracer('default');
  const span = tracer.startSpan(spanName);
  return span as Span;
}

function createUnsampledSpan(spanName: string): Span {
  const tracer = new BasicTracerProvider({
    sampler: AlwaysRecordSampler.create(new AlwaysOffSampler()),
  }).getTracer('default');
  const span = tracer.startSpan(spanName);
  return span as Span;
}

describe('AwsBatchUnsampledSpanProcessor', () => {
  const name = 'span-name';
  const defaultBufferConfig = {
    maxExportBatchSize: 5,
    scheduledDelayMillis: 2500,
  };
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
  });

  afterEach(() => {
    exporter.reset();
    sinon.restore();
  });

  describe('constructor', () => {
    it('should read defaults from environment', () => {
      const bspConfig = {
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: 256,
        OTEL_BSP_SCHEDULE_DELAY: 2500,
      };

      let env: Record<string, any>;
      if (global.process?.versions?.node === undefined) {
        env = globalThis as unknown as Record<string, any>;
      } else {
        env = process.env as Record<string, any>;
      }

      Object.entries(bspConfig).forEach(([k, v]) => {
        env[k] = v;
      });

      const processor = new AwsBatchUnsampledSpanProcessor(exporter);
      assert.strictEqual(processor['_maxExportBatchSize'], 256);
      assert.strictEqual(processor['_scheduledDelayMillis'], 2500);
      processor.shutdown();

      Object.keys(bspConfig).forEach(k => delete env[k]);
    });
  });

  describe('.onStart/.onEnd/.shutdown', () => {
    it('should call onShutdown', async () => {
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);
      const onShutdownSpy = sinon.stub(processor, 'onShutdown');
      assert.strictEqual(onShutdownSpy.callCount, 0);
      await processor.shutdown();
      assert.strictEqual(onShutdownSpy.callCount, 1);
    });

    it('should do nothing after processor is shutdown', async () => {
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);
      const spy: sinon.SinonSpy = sinon.spy(exporter, 'export') as any;

      const span = createUnsampledSpan(`${name}_0`);

      processor.onStart(span, ROOT_CONTEXT);
      processor.onEnd(span);
      assert.strictEqual(processor['_finishedSpans'].length, 1);

      await processor.forceFlush();
      assert.strictEqual(exporter.getFinishedSpans().length, 1);

      processor.onStart(span, ROOT_CONTEXT);
      processor.onEnd(span);
      assert.strictEqual(processor['_finishedSpans'].length, 1);

      assert.strictEqual(spy.args.length, 1);
      await processor.shutdown();
      assert.strictEqual(spy.args.length, 2);
      assert.strictEqual(exporter.getFinishedSpans().length, 0);

      processor.onStart(span, ROOT_CONTEXT);
      processor.onEnd(span);
      assert.strictEqual(spy.args.length, 2);
      assert.strictEqual(processor['_finishedSpans'].length, 0);
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
    });

    it('should export unsampled spans', async () => {
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);
      const spy: sinon.SinonSpy = sinon.spy(exporter, 'export') as any;

      const span = createUnsampledSpan(`${name}_0`);

      processor.onStart(span, ROOT_CONTEXT);
      processor.onEnd(span);

      await processor.forceFlush();
      // _finishedSpans should be empty after forceFlush
      assert.strictEqual(processor['_finishedSpans'].length, 0);
      assert.strictEqual(exporter.getFinishedSpans().length, 1);
      assert.strictEqual(spy.args.length, 1);
    });

    it('should not export sampled spans', async () => {
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);
      const spy: sinon.SinonSpy = sinon.spy(exporter, 'export') as any;

      const span = createSampledSpan(`${name}_0`);

      processor.onStart(span, ROOT_CONTEXT);
      processor.onEnd(span);

      await processor.forceFlush();
      // _finishedSpans should be empty after forceFlush
      assert.strictEqual(processor['_finishedSpans'].length, 0);
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
      assert.strictEqual(spy.args.length, 0);
    });

    it('should export the sampled spans with buffer size reached', async () => {
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);
      const span = createUnsampledSpan(name);
      for (let i = 1; i < defaultBufferConfig.maxExportBatchSize; i++) {
        processor.onStart(span, ROOT_CONTEXT);
        assert.strictEqual(exporter.getFinishedSpans().length, 0);

        processor.onEnd(span);
        assert.strictEqual(exporter.getFinishedSpans().length, 0);
      }
      processor.onStart(span, ROOT_CONTEXT);
      processor.onEnd(span);
      assert.strictEqual(exporter.getFinishedSpans().length, 5);
      await processor.shutdown();
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
    });

    it('should force flush when timeout exceeded', done => {
      const clock = sinon.useFakeTimers();
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);
      const span = createUnsampledSpan(name);
      for (let i = 1; i < defaultBufferConfig.maxExportBatchSize; i++) {
        processor.onStart(span, ROOT_CONTEXT);
        processor.onEnd(span);
        assert.strictEqual(exporter.getFinishedSpans().length, 0);
      }

      setTimeout(() => {
        assert.strictEqual(exporter.getFinishedSpans().length, 4);
        done();
      }, defaultBufferConfig.scheduledDelayMillis + 1000);

      clock.tick(defaultBufferConfig.scheduledDelayMillis + 1000);

      clock.restore();
    });

    it('should force flush on demand', () => {
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);
      const span = createUnsampledSpan(name);
      for (let i = 1; i < defaultBufferConfig.maxExportBatchSize; i++) {
        processor.onStart(span, ROOT_CONTEXT);
        processor.onEnd(span);
      }
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
      processor.forceFlush();
      assert.strictEqual(exporter.getFinishedSpans().length, 4);
    });

    it('should not export empty span lists', done => {
      const spy = sinon.spy(exporter, 'export');
      const clock = sinon.useFakeTimers();

      const tracer = new BasicTracerProvider({
        sampler: new AlwaysOnSampler(),
      }).getTracer('default');
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);

      // start but do not end spans
      for (let i = 0; i < defaultBufferConfig.maxExportBatchSize; i++) {
        const span = tracer.startSpan('spanName');
        processor.onStart(span as Span, ROOT_CONTEXT);
      }

      setTimeout(() => {
        assert.strictEqual(exporter.getFinishedSpans().length, 0);
        // after the timeout, export should not have been called
        // because no spans are ended
        sinon.assert.notCalled(spy);
        done();
      }, defaultBufferConfig.scheduledDelayMillis + 1000);

      // no spans have been finished
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
      clock.tick(defaultBufferConfig.scheduledDelayMillis + 1000);

      clock.restore();
    });

    it('should export each unsampled span exactly once with buffer size' + ' reached multiple times', done => {
      const originalTimeout = setTimeout;
      const clock = sinon.useFakeTimers();
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);
      const totalSpans = defaultBufferConfig.maxExportBatchSize * 2;
      for (let i = 0; i < totalSpans; i++) {
        const span = createUnsampledSpan(`${name}_${i}`);
        processor.onStart(span, ROOT_CONTEXT);
        processor.onEnd(span);
      }
      const span = createSampledSpan(`${name}_last`);
      processor.onStart(span, ROOT_CONTEXT);
      processor.onEnd(span);
      clock.tick(defaultBufferConfig.scheduledDelayMillis + 10);

      // because there is an async promise that will be trigger original
      // timeout is needed to simulate a real tick to the next
      originalTimeout(() => {
        clock.tick(defaultBufferConfig.scheduledDelayMillis + 10);
        originalTimeout(async () => {
          clock.tick(defaultBufferConfig.scheduledDelayMillis + 10);
          clock.restore();

          diag.info('finished spans count', exporter.getFinishedSpans().length);
          assert.strictEqual(exporter.getFinishedSpans().length, totalSpans);

          await processor.shutdown();
          assert.strictEqual(exporter.getFinishedSpans().length, 0);
          done();
        });
      });
    });
  });

  describe('force flush', () => {
    describe('no waiting spans', () => {
      it('should call an async callback when flushing is complete', done => {
        const processor = new AwsBatchUnsampledSpanProcessor(exporter);
        processor.forceFlush().then(() => {
          done();
        });
      });

      it('should call an async callback when shutdown is complete', done => {
        const processor = new AwsBatchUnsampledSpanProcessor(exporter);
        processor.shutdown().then(() => {
          done();
        });
      });
    });

    describe('spans waiting to flush', () => {
      let processor: AwsBatchUnsampledSpanProcessor;

      beforeEach(() => {
        processor = new AwsBatchUnsampledSpanProcessor(exporter, defaultBufferConfig);
      });

      it('should call an async callback when flushing is complete', done => {
        const span = createUnsampledSpan('test');
        processor.onStart(span, ROOT_CONTEXT);
        processor.onEnd(span);
        processor.forceFlush().then(() => {
          assert.strictEqual(exporter.getFinishedSpans().length, 1);
          done();
        });
      });

      it('should call an async callback when shutdown is complete', done => {
        let exportedSpans = 0;
        sinon.stub(exporter, 'export').callsFake((spans, callback) => {
          setTimeout(() => {
            exportedSpans = exportedSpans + spans.length;
            callback({ code: ExportResultCode.SUCCESS });
          }, 0);
        });
        const span = createUnsampledSpan('test');
        processor.onStart(span, ROOT_CONTEXT);
        processor.onEnd(span);

        processor.shutdown().then(() => {
          assert.strictEqual(exportedSpans, 1);
          done();
        });
      });

      it('should call globalErrorHandler when exporting fails', done => {
        const clock = sinon.useFakeTimers();
        const expectedError = new Error('Exporter failed');
        sinon.stub(exporter, 'export').callsFake((_, callback) => {
          setTimeout(() => {
            callback({ code: ExportResultCode.FAILED, error: expectedError });
          }, 0);
        });

        const errorHandlerSpy = sinon.spy();

        setGlobalErrorHandler(errorHandlerSpy);

        for (let i = 0; i < defaultBufferConfig.maxExportBatchSize; i++) {
          const span = createUnsampledSpan('test');
          processor.onStart(span, ROOT_CONTEXT);
          processor.onEnd(span);
        }

        clock.tick(defaultBufferConfig.scheduledDelayMillis + 1000);
        clock.restore();
        setTimeout(async () => {
          assert.strictEqual(errorHandlerSpy.callCount, 1);

          const [[error]] = errorHandlerSpy.args;

          assert.deepStrictEqual(error, expectedError);

          //reset global error handler
          setGlobalErrorHandler(loggingErrorHandler());
          done();
        });
      });

      it('should wait for pending resource on flush', async () => {
        const tracer = new BasicTracerProvider({
          sampler: AlwaysRecordSampler.create(new AlwaysOffSampler()),
          resource: new Resource(
            {},
            new Promise<ResourceAttributes>(resolve => {
              setTimeout(() => resolve({ async: 'fromasync' }), 1);
            })
          ),
        }).getTracer('default');

        const span = tracer.startSpan('test') as Span;
        span.end();

        processor.onStart(span, ROOT_CONTEXT);
        processor.onEnd(span);

        await processor.forceFlush();

        assert.strictEqual(exporter.getFinishedSpans().length, 1);
      });
    });
  });
  describe('maxQueueSize', () => {
    let processor: AwsBatchUnsampledSpanProcessor;

    describe('when there are more spans then "maxQueueSize"', () => {
      beforeEach(() => {
        processor = new AwsBatchUnsampledSpanProcessor(
          exporter,
          Object.assign({}, defaultBufferConfig, {
            maxQueueSize: 6,
          })
        );
      });
      it('should drop spans', () => {
        const span = createUnsampledSpan('test');
        for (let i = 0, j = 20; i < j; i++) {
          processor.onStart(span, ROOT_CONTEXT);
          processor.onEnd(span);
        }
        assert.equal(processor['_finishedSpans'].length, 6);
      });
      it('should count and report dropped spans', done => {
        const debugStub = sinon.spy(diag, 'debug');
        const warnStub = sinon.spy(diag, 'warn');
        // const span = createUnsampledSpan('test');
        for (let i = 0, j = 12; i < j; i++) {
          const span = createUnsampledSpan('test' + i);
          processor.onStart(span, ROOT_CONTEXT);
          processor.onEnd(span);
        }
        assert.equal(processor['_finishedSpans'].length, 6);
        assert.equal(processor['_droppedSpansCount'], 1);
        sinon.assert.calledOnce(debugStub);

        processor.forceFlush().then(() => {
          const span = createUnsampledSpan('test');
          processor.onStart(span, ROOT_CONTEXT);
          processor.onEnd(span);

          assert.equal(processor['_finishedSpans'].length, 1);
          assert.equal(processor['_droppedSpansCount'], 0);

          sinon.assert.calledOnce(warnStub);
          done();
        });
      });
    });
  });

  describe('maxExportBatchSize', () => {
    let processor: AwsBatchUnsampledSpanProcessor;

    describe('when "maxExportBatchSize" is greater than "maxQueueSize"', () => {
      beforeEach(() => {
        processor = new AwsBatchUnsampledSpanProcessor(exporter, {
          maxExportBatchSize: 7,
          maxQueueSize: 6,
        });
      });
      it('should match maxQueueSize', () => {
        assert.equal(processor['_maxExportBatchSize'], processor['_maxQueueSize']);
      });
    });
  });

  describe('Concurrency', () => {
    it('should only send a single batch at a time', async () => {
      const callbacks: ((result: ExportResult) => void)[] = [];
      const spans: ReadableSpan[] = [];
      const exporter: SpanExporter = {
        export: async (exportedSpans: ReadableSpan[], resultCallback: (result: ExportResult) => void) => {
          callbacks.push(resultCallback);
          spans.push(...exportedSpans);
        },
        shutdown: async () => {},
      };
      const processor = new AwsBatchUnsampledSpanProcessor(exporter, {
        maxExportBatchSize: 5,
        maxQueueSize: 6,
      });
      const totalSpans = 50;
      for (let i = 0; i < totalSpans; i++) {
        const span = createUnsampledSpan(`${name}_${i}`);
        processor.onStart(span, ROOT_CONTEXT);
        processor.onEnd(span);
      }
      assert.equal(callbacks.length, 1);
      assert.equal(spans.length, 5);
      callbacks[0]({ code: ExportResultCode.SUCCESS });
      await new Promise(resolve => setTimeout(resolve, 0));
      // After the first batch completes we will have dropped a number
      // of spans and the next batch will be smaller
      assert.equal(callbacks.length, 2);
      assert.equal(spans.length, 10);
      callbacks[1]({ code: ExportResultCode.SUCCESS });

      // We expect that all the other spans have been dropped
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(callbacks.length, 2);
      assert.equal(spans.length, 10);
    });
  });
});
