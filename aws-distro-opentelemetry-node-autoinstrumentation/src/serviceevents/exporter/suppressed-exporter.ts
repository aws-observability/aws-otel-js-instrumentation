// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wraps an OTLP exporter so its internal HTTP/gRPC calls are not traced.
 *
 * ServiceEvents emits its own signals to a dedicated OTLP endpoint. Without this
 * wrapper, `@opentelemetry/instrumentation-http` (or -grpc) creates a CLIENT
 * span for each export request, which then flows back through the app's
 * tracer, polluting user telemetry and — in contract tests — creating
 * unexpected spans alongside AWS SDK calls.
 *
 * OTel's built-in trace-processor pipeline (sdk-trace-base) already wraps
 * span exports in `suppressTracing`. Log and metric exporters do not, so we
 * need to do it ourselves.
 */

import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

interface ExporterLike {
  export(items: unknown, resultCallback: (result: unknown) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

export function wrapExporterSuppressed<T extends ExporterLike>(exporter: T): T {
  const originalExport = exporter.export.bind(exporter);
  exporter.export = function (items: unknown, resultCallback: (result: unknown) => void): void {
    context.with(suppressTracing(context.active()), () => {
      originalExport(items, resultCallback);
    });
  };
  return exporter;
}
