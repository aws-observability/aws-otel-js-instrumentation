// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import { context, Context, diag, TraceFlags } from '@opentelemetry/api';
import {
  BindOnceFuture,
  ExportResultCode,
  getEnv,
  globalErrorHandler,
  suppressTracing,
  unrefTimer,
} from '@opentelemetry/core';
import { ReadableSpan, BufferConfig, Span, SpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { AWS_ATTRIBUTE_KEYS } from './aws-attribute-keys';

/**
 * This class is a customized version of the `BatchSpanProcessorBase` from the
 * OpenTelemetry SDK (`@opentelemetry/sdk-trace-base/build/src/export/BatchSpanProcessorBase`).
 * It inherits much of the behavior of the `BatchSpanProcessorBase` while adding
 * specific logic to handle unsampled spans.
 *
 * It can't directly be inherited `BatchSpanProcessorBase` as child class because
 * a few stateful fields are private in `BatchSpanProcessorBase` which need to be accessed
 * in `AwsBatchUnsampledSpanProcessor` and we don't plan to update upstream code for it.
 *
 * In particular, the following methods are modified:
 *
 * 1. `onStart`: This method is modified to detect unsampled spans and add an
 *    AWS-specific attribute (`AWS_TRACE_FLAG_UNSAMPLED`) to denote that the span
 *    is unsampled. This is done by checking the `traceFlags` of the span.
 *
 * 2. `onEnd`: The logic here is changed to handle unsampled spans. While the
 *    default behavior of `BatchSpanProcessorBase` is to ignore unsampled spans,
 *    this version adds them to the buffer for export. The unsampled spans are
 *    queued and processed similarly to sampled spans.
 *
 * This processor ensures that even unsampled spans are exported, which is a
 * deviation from the typical span processing behavior in OpenTelemetry.
 *
 * The rest of the behavior—batch processing, queuing, and exporting spans in
 * batches—is inherited from the base class and remains largely the same.
 */
export class AwsBatchUnsampledSpanProcessor implements SpanProcessor {
  private readonly _maxExportBatchSize: number;
  private readonly _maxQueueSize: number;
  private readonly _scheduledDelayMillis: number;
  private readonly _exportTimeoutMillis: number;

  private _isExporting = false;
  private _finishedSpans: ReadableSpan[] = [];
  private _timer: NodeJS.Timeout | undefined;
  private _shutdownOnce: BindOnceFuture<void>;
  private _droppedSpansCount: number = 0;

  constructor(private readonly _exporter: SpanExporter, config?: BufferConfig) {
    const env = getEnv();
    this._maxExportBatchSize =
      typeof config?.maxExportBatchSize === 'number' ? config.maxExportBatchSize : env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE;
    this._maxQueueSize = typeof config?.maxQueueSize === 'number' ? config.maxQueueSize : env.OTEL_BSP_MAX_QUEUE_SIZE;
    this._scheduledDelayMillis =
      typeof config?.scheduledDelayMillis === 'number' ? config.scheduledDelayMillis : env.OTEL_BSP_SCHEDULE_DELAY;
    this._exportTimeoutMillis =
      typeof config?.exportTimeoutMillis === 'number' ? config.exportTimeoutMillis : env.OTEL_BSP_EXPORT_TIMEOUT;

    this._shutdownOnce = new BindOnceFuture(this._shutdown, this);

    if (this._maxExportBatchSize > this._maxQueueSize) {
      diag.warn(
        'BatchSpanProcessor: maxExportBatchSize must be smaller or equal to maxQueueSize, setting maxExportBatchSize to match maxQueueSize'
      );
      this._maxExportBatchSize = this._maxQueueSize;
    }
  }

  forceFlush(): Promise<void> {
    if (this._shutdownOnce.isCalled) {
      return this._shutdownOnce.promise;
    }
    return this._flushAll();
  }

  onStart(span: Span, _parentContext: Context): void {
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) {
      span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_TRACE_FLAG_UNSAMPLED, true);
      return;
    }
  }

  onEnd(span: ReadableSpan): void {
    if (this._shutdownOnce.isCalled) {
      return;
    }

    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 1) {
      return;
    }

    this._addToBuffer(span);
  }

  shutdown(): Promise<void> {
    return this._shutdownOnce.call();
  }

  private _shutdown() {
    return Promise.resolve()
      .then(() => {
        return this.onShutdown();
      })
      .then(() => {
        return this._flushAll();
      })
      .then(() => {
        return this._exporter.shutdown();
      });
  }

  /** Add a span in the buffer. */
  private _addToBuffer(span: ReadableSpan) {
    if (this._finishedSpans.length >= this._maxQueueSize) {
      // limit reached, drop span

      if (this._droppedSpansCount === 0) {
        diag.debug('maxQueueSize reached, dropping spans');
      }
      this._droppedSpansCount++;

      return;
    }

    if (this._droppedSpansCount > 0) {
      // some spans were dropped, log once with count of spans dropped
      diag.warn(`Dropped ${this._droppedSpansCount} spans because maxQueueSize reached`);
      this._droppedSpansCount = 0;
    }

    this._finishedSpans.push(span);
    this._maybeStartTimer();
  }

  /**
   * Send all spans to the exporter respecting the batch size limit
   * This function is used only on forceFlush or shutdown,
   * for all other cases _flush should be used
   * */
  private _flushAll(): Promise<void> {
    return new Promise((resolve, reject) => {
      const promises = [];
      // calculate number of batches
      const count = Math.ceil(this._finishedSpans.length / this._maxExportBatchSize);
      for (let i = 0, j = count; i < j; i++) {
        promises.push(this._flushOneBatch());
      }
      Promise.all(promises)
        .then(() => {
          resolve();
        })
        .catch(reject);
    });
  }

  private _flushOneBatch(): Promise<void> {
    this._clearTimer();
    if (this._finishedSpans.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // don't wait anymore for export, this way the next batch can start
        reject(new Error('Timeout'));
      }, this._exportTimeoutMillis);
      // prevent downstream exporter calls from generating spans
      context.with(suppressTracing(context.active()), () => {
        // Reset the finished spans buffer here because the next invocations of the _flush method
        // could pass the same finished spans to the exporter if the buffer is cleared
        // outside the execution of this callback.
        let spans: ReadableSpan[];
        if (this._finishedSpans.length <= this._maxExportBatchSize) {
          spans = this._finishedSpans;
          this._finishedSpans = [];
        } else {
          spans = this._finishedSpans.splice(0, this._maxExportBatchSize);
        }

        const doExport = () =>
          this._exporter.export(spans, result => {
            clearTimeout(timer);
            if (result.code === ExportResultCode.SUCCESS) {
              resolve();
            } else {
              reject(result.error ?? new Error('BatchSpanProcessor: span export failed'));
            }
          });

        let pendingResources: Array<Promise<void>> | null = null;
        for (let i = 0, len = spans.length; i < len; i++) {
          const span = spans[i];
          if (span.resource.asyncAttributesPending && span.resource.waitForAsyncAttributes) {
            pendingResources ??= [];
            pendingResources.push(span.resource.waitForAsyncAttributes());
          }
        }

        // Avoid scheduling a promise to make the behavior more predictable and easier to test
        if (pendingResources === null) {
          doExport();
        } else {
          Promise.all(pendingResources).then(doExport, err => {
            globalErrorHandler(err);
            reject(err);
          });
        }
      });
    });
  }

  private _maybeStartTimer() {
    if (this._isExporting) return;
    const flush = () => {
      this._isExporting = true;
      this._flushOneBatch()
        .finally(() => {
          this._isExporting = false;
          if (this._finishedSpans.length > 0) {
            this._clearTimer();
            this._maybeStartTimer();
          }
        })
        .catch(e => {
          this._isExporting = false;
          globalErrorHandler(e);
        });
    };
    // we only wait if the queue doesn't have enough elements yet
    if (this._finishedSpans.length >= this._maxExportBatchSize) {
      return flush();
    }
    if (this._timer !== undefined) return;
    this._timer = setTimeout(() => flush(), this._scheduledDelayMillis);
    unrefTimer(this._timer);
  }

  private _clearTimer() {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }

  onShutdown(): void {}
}
