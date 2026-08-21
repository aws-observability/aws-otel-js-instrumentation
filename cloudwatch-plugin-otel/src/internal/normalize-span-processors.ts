// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure config-normalization for the zero-code register patch (CONFIG layout, sdk-node >= 0.220).
//
// NodeSDK derives span processors from this._configuration with a precedence:
//   spanProcessors ?? [spanProcessor] ?? [batch(traceExporter)] ?? env
// and treats those inputs as mutually exclusive — once spanProcessors is set, traceExporter and
// spanProcessor are ignored. To inject our processor we must produce an explicit spanProcessors list
// that preserves whatever export the user already configured, then append ours.
//
// Extracted as a pure function (factories injected) so it is unit-testable without constructing a
// real NodeSDK or a live backend.

export interface NormalizeConfig {
  spanProcessors?: unknown[];
  spanProcessor?: unknown;
  traceExporter?: unknown;
  [key: string]: unknown;
}

export interface NormalizeDeps {
  // Our span-metrics processor to append.
  makeSpanMetricsProcessor: () => unknown;
  // Wrap a lone traceExporter as NodeSDK would (BatchSpanProcessor from the SDK's own sdk-trace-base).
  wrapExporter: (exporter: unknown) => unknown;
  // Span processors the SDK would build from the environment when nothing else is configured.
  // Returns undefined when they cannot be resolved (see the abort contract below); an empty array is
  // a legitimate result (e.g. OTEL_TRACES_EXPORTER=none) and normalizes normally.
  envSpanProcessors: () => unknown[] | undefined;
}

// Mutates `cfg` in place: sets cfg.spanProcessors to the resolved list (existing/derived + ours) and
// removes any input the SDK would otherwise ignore. Returns the resolved list for convenience.
//
// Abort contract: when the env branch is reached and deps.envSpanProcessors() returns undefined,
// this returns undefined WITHOUT touching cfg. Setting spanProcessors to just our processor there
// would make NodeSDK skip its own env wiring and silently drop the user's span export; leaving cfg
// untouched lets NodeSDK wire export upstream-style, and only the extension stays inert (which the
// register patch's post-start self-verify reports).
export function normalizeSpanProcessors(cfg: NormalizeConfig, deps: NormalizeDeps): unknown[] | undefined {
  let processors: unknown[];
  if (cfg.spanProcessors) {
    processors = [...cfg.spanProcessors];
    // Plural wins (NodeSDK precedence); delete the losing singular so NodeSDK does not emit its
    // deprecation warning for an option that had no effect.
    delete cfg.spanProcessor;
  } else if (cfg.spanProcessor) {
    processors = [cfg.spanProcessor];
    delete cfg.spanProcessor;
  } else if (cfg.traceExporter) {
    // Robustness: register users are env-driven, but this class patch also runs for a programmatic
    // NodeSDK({ traceExporter }). Setting spanProcessors would make NodeSDK ignore traceExporter, so
    // convert it (as NodeSDK would) and drop it to preserve the user's span export.
    processors = [deps.wrapExporter(cfg.traceExporter)];
    delete cfg.traceExporter;
  } else {
    const envProcessors = deps.envSpanProcessors();
    if (envProcessors === undefined) {
      return undefined;
    }
    processors = [...envProcessors];
  }
  processors.push(deps.makeSpanMetricsProcessor());
  cfg.spanProcessors = processors;
  return processors;
}
