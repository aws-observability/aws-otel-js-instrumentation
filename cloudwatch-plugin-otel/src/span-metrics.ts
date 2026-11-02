// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { MeterProvider, diag } from '@opentelemetry/api';
import { BatchSpanProcessor, Sampler, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AlwaysRecordSampler } from './always-record-sampler';
import { SpanMetricsProcessor } from './span-metrics-processor';
import * as holder from './internal/open-telemetry-holder';
import { resolveEnvSamplerOrDefault } from './internal/env-sampler';
import { normalizeSpanProcessors, TRACE_EXPORT_DISABLED_MESSAGE } from './internal/normalize-span-processors';

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
 * Mode 2 (programmatic NodeSDK): transform a NodeSDK config so the extension is wired in. The
 * config's trace output is resolved with NodeSDK's own truthiness precedence
 * (spanProcessors > spanProcessor > traceExporter; null/undefined fall through like absent — they
 * are never a "disable" signal), via the same shared normalizer the zero-code register patch uses:
 *
 * - spanProcessors non-empty: ours appended; losing singular/exporter removed with a warning.
 * - spanProcessors EMPTY: trace export is disabled — upstream NodeSDK registers no tracer provider
 *   for it, so adding ours would create a recording provider and change trace-context propagation
 *   downstream. The transform warns and returns the config UNCHANGED; span metrics stay off.
 * - Deprecated singular spanProcessor: honored, converted into spanProcessors, deprecation warning.
 * - traceExporter only: converted into a BatchSpanProcessor (NodeSDK ignores traceExporter once
 *   spanProcessors is set) and removed, so the user's span export is preserved.
 * - NOTHING trace-related configured: warns and returns the config UNCHANGED (sampler included).
 *   NodeSDK builds span export from env/defaults only when processors are not explicitly
 *   configured, and this pure transform cannot replicate that wiring (no handle on the caller's
 *   sdk-node copy) — setting spanProcessors here would silently drop all span export while the
 *   100% metrics masked the loss. Env-driven trace setups should use the zero-code register hook.
 *
 * On every non-abort path the sampler is wrapped to force-record: the explicit config.sampler, else
 * the OTEL_TRACES_SAMPLER(+_ARG) env sampler, else the SDK default.
 *
 * The input object is NEVER mutated: the transform operates on a shallow copy and returns it (a
 * frozen or sealed config is fine). On the abort path the original object is returned as-is.
 * No patching. The caller still binds the MeterProvider after start via {@link bind} (the SDK
 * owns it).
 */
export function withSpanMetrics<T extends NodeSdkConfigLike>(config: T): T {
  // Guard FIRST, so the abort path is a complete no-op — even the sampler stays unwrapped
  // (force-recording spans that no processor consumes would only add overhead). Same truthiness the
  // normalizer and NodeSDK use, so null fields fall through like absent ones.
  if (!config.spanProcessors && !config.spanProcessor && !config.traceExporter) {
    diag.warn(
      '[span-metrics] no traceExporter/spanProcessors (or deprecated spanProcessor) in the NodeSDK ' +
        'config; span metrics are DISABLED for this SDK and the config is unchanged, so env/default ' +
        'span export continues. To enable span metrics in programmatic mode, configure an explicit ' +
        'traceExporter or spanProcessors (or use the zero-code register hook, which supports ' +
        'env-driven export).'
    );
    return config;
  }
  // An explicitly EMPTY spanProcessors array means trace export is disabled: upstream NodeSDK then
  // registers NO tracer provider, so spans are non-recording and no sampled trace context is
  // injected downstream. Wiring the extension in would create a recording provider and flip
  // downstream sampling decisions — abort instead, before any copy or sampler wrap, so tracing
  // behavior stays byte-identical to upstream. (The normalizer carries the same rule for the
  // zero-code path; this early return keeps the abort a complete no-op here.)
  if (config.spanProcessors && config.spanProcessors.length === 0) {
    diag.warn(TRACE_EXPORT_DISABLED_MESSAGE);
    return config;
  }

  // Work on a shallow copy: the caller's object is never written to (it may be frozen, shared, or
  // reused), and the deletes/overwrites below apply only to the copy we hand back.
  const cfg = { ...config };

  // Force-record the configured sampler. The base is the explicit config.sampler, or — when the user
  // configures sampling through OTEL_TRACES_SAMPLER(+_ARG) and leaves config.sampler unset — the env
  // sampler, or the SDK's own default when neither is set. We always resolve a concrete sampler and
  // wrap it (rather than leaving it unset for the SDK to build) so this mode force-records in exactly
  // the same cases as zero-code, instead of relying on the SDK default happening to be AlwaysOn.
  const base = cfg.sampler ?? resolveEnvSamplerOrDefault();
  cfg.sampler = AlwaysRecordSampler.create(base);

  // Shared resolution with the zero-code path — one implementation of NodeSDK's precedence, one set
  // of warnings. The env branch is unreachable here (the guard above returned already), so the
  // env dep is the abort-safe constant.
  normalizeSpanProcessors(cfg, {
    makeSpanMetricsProcessor: () => new SpanMetricsProcessor(),
    wrapExporter: exporter => new BatchSpanProcessor(exporter as SpanExporter),
    envSpanProcessors: () => undefined,
    warn: message => diag.warn(message),
  });
  return cfg;
}
