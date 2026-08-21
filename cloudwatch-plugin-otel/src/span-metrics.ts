// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { MeterProvider, diag } from '@opentelemetry/api';
import { BatchSpanProcessor, Sampler, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AlwaysRecordSampler } from './always-record-sampler';
import { SpanMetricsProcessor } from './span-metrics-processor';
import * as holder from './internal/open-telemetry-holder';
import { resolveEnvSamplerOrDefault } from './internal/env-sampler';

// Subset of the NodeSDK configuration this module reads/transforms. Declared structurally so the
// module does not take a hard dependency on @opentelemetry/sdk-node (only Mode 2 users have it).
interface NodeSdkConfigLike {
  sampler?: Sampler;
  spanProcessors?: SpanProcessor[];
  // Deprecated singular option: honored with NodeSDK precedence and converted into spanProcessors
  // (see withSpanMetrics), then removed from the config.
  spanProcessor?: SpanProcessor;
  traceExporter?: SpanExporter;
  [key: string]: unknown;
}

/**
 * Mode 3 (manual SDK setup): after building the OpenTelemetry MeterProvider, call bind() so
 * {@link SpanMetricsProcessor} can obtain a Meter. Mode 1 (register) and Mode 2 (withSpanMetrics)
 * call this internally and do not require the user to.
 */
export function bind(meterProvider: MeterProvider): void {
  holder.set(meterProvider);
}

/**
 * Mode 2 (programmatic NodeSDK): transform a NodeSDK config so the extension is wired in. Wraps the
 * configured sampler (if set) to force-record, and ensures our span processor is in the config's
 * spanProcessors list.
 *
 * NodeSDK treats spanProcessors and traceExporter as mutually exclusive: when spanProcessors is set,
 * traceExporter is ignored. So a config that used ONLY traceExporter must have that exporter
 * converted into a BatchSpanProcessor here, otherwise appending our processor would silently drop
 * the user's span export. We mirror the SDK's own default wrapping (new BatchSpanProcessor(exporter))
 * and remove traceExporter so the SDK does not see both.
 *
 * The deprecated singular spanProcessor option is honored with NodeSDK's own precedence
 * (spanProcessors > spanProcessor > traceExporter) and converted into the spanProcessors list, with
 * a deprecation warning.
 *
 * Pure transform on public config fields; no patching. The caller still binds the MeterProvider
 * after start via {@link bind} (the SDK owns it).
 */
export function withSpanMetrics<T extends NodeSdkConfigLike>(config: T): T {
  // Force-record the configured sampler. The base is the explicit config.sampler, or — when the user
  // configures sampling through OTEL_TRACES_SAMPLER(+_ARG) and leaves config.sampler unset — the env
  // sampler, or the SDK's own default when neither is set. We always resolve a concrete sampler and
  // wrap it (rather than leaving it unset for the SDK to build) so this mode force-records in exactly
  // the same cases as zero-code, instead of relying on the SDK default happening to be AlwaysOn.
  const base = config.sampler ?? resolveEnvSamplerOrDefault();
  config.sampler = AlwaysRecordSampler.create(base);

  let processors: SpanProcessor[];
  if (config.spanProcessors) {
    processors = [...config.spanProcessors];
    if (config.spanProcessor) {
      // Plural wins (NodeSDK precedence). Delete the loser and say so — leaving it dangling would
      // make NodeSDK emit its generic deprecation warning, implying the singular processor is in
      // play when it was actually ignored.
      diag.warn(
        "[span-metrics] both 'spanProcessors' and the deprecated 'spanProcessor' (singular) were " +
          "set; 'spanProcessors' wins (NodeSDK precedence) and the singular processor is IGNORED."
      );
      delete config.spanProcessor;
    }
  } else if (config.spanProcessor) {
    // Deprecated singular option (sdk-node 0.51.0, 2024-04): honored exactly as NodeSDK still does
    // (plural > singular > traceExporter precedence), then removed so it cannot dangle beside the
    // spanProcessors list we set below. Ignoring it would silently drop the user's span export while
    // our 100% metrics masked the loss. Remove this branch when upstream NodeSDK removes the option.
    diag.warn(
      "[span-metrics] the 'spanProcessor' (singular) NodeSDK option is deprecated; it was converted " +
        "to 'spanProcessors'. Please migrate to 'spanProcessors'."
    );
    processors = [config.spanProcessor];
    delete config.spanProcessor;
  } else if (config.traceExporter) {
    // Convert the lone traceExporter to a processor (mirrors NodeSDK's default) and drop it, so the
    // SDK does not ignore it once spanProcessors is set below.
    processors = [new BatchSpanProcessor(config.traceExporter)];
    delete config.traceExporter;
  } else {
    processors = [];
  }
  processors.push(new SpanMetricsProcessor());
  config.spanProcessors = processors;
  return config;
}
