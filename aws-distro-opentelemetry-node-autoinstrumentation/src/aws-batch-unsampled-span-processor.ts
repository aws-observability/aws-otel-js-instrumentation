// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import { Context, TraceFlags } from '@opentelemetry/api';
import { BatchSpanProcessor, ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import { AWS_ATTRIBUTE_KEYS } from './aws-attribute-keys';

/**
 * This class is a customized version of the `BatchSpanProcessor` from the
 * OpenTelemetry SDK (`@opentelemetry/sdk-trace-base`). It inherits much of the behavior of
 * the `BatchSpanProcessor` while adding specific logic to handle unsampled spans.
 *
 * A few stateful fields of the upstream processor are private and need to be accessed here,
 * so they are reached through `(this as any)` rather than by updating upstream code.
 *
 * In particular, the following methods are modified:
 *
 * 1. `onStart`: This method is modified to detect unsampled spans and add an
 *    AWS-specific attribute (`AWS_TRACE_FLAG_SAMPLED`) to denote that the span
 *    is unsampled. This is done by checking the `traceFlags` of the span.
 *
 * 2. `onEnd`: The logic here is changed to handle unsampled spans. While the
 *    default behavior of `BatchSpanProcessor` is to ignore unsampled spans,
 *    this version adds them to the buffer for export. The unsampled spans are
 *    queued and processed similarly to sampled spans.
 *
 * This processor ensures that even unsampled spans are exported, which is a
 * deviation from the typical span processing behavior in OpenTelemetry.
 *
 * The rest of the behavior—batch processing, queuing, and exporting spans in
 * batches—is inherited from the base class and remains largely the same.
 */
export class AwsBatchUnsampledSpanProcessor extends BatchSpanProcessor {
  override onStart(span: Span, _parentContext: Context): void {
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) {
      span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_TRACE_FLAG_SAMPLED, false);
      return;
    }
  }

  override onEnd(span: ReadableSpan): void {
    if ((this as any)._shutdownOnce.isCalled) {
      return;
    }

    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 1) {
      return;
    }

    (this as any)._addToBuffer(span);
  }

  override onShutdown(): void {}
}
