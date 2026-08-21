// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// THE single implementation of NodeSDK trace-output resolution for this extension, used by BOTH
// wiring modes: the zero-code register patch (CONFIG layout) and the public withSpanMetrics API.
// Any behavior change here changes both modes — that is the point (the two previously drifted).
//
// NodeSDK derives span processors from its configuration with a TRUTHINESS precedence chain
// (verified against sdk-node 0.203, 0.219, 0.221 — identical in all supported eras):
//   spanProcessors → [spanProcessor] → [batch(traceExporter)] → env
// Consequences this module must honor:
//   - null/undefined are never a "disable" signal; they fall through like absent fields.
//   - A defined EMPTY spanProcessors array is truthy: it wins the chain and NodeSDK then builds no
//     export and registers no tracer provider. Appending only our processor there costs the user
//     nothing they had not already chosen — it is the metrics-without-trace-export recipe.
//   - Once spanProcessors is set, the losing fields (spanProcessor, traceExporter) are dead weight:
//     NodeSDK ignores them. Every consumed or out-precedenced input is deleted, with a warning when
//     the user's component is dropped rather than converted. (Deleting a dangling singular also
//     prevents NodeSDK's own constructor-time deprecation warning — but only on the withSpanMetrics
//     path, which runs before construction; on the register path NodeSDK has already warned.)
//
// Extracted as a pure function (factories injected) so it is unit-testable without constructing a
// real NodeSDK or a live backend.

export interface NormalizeConfig {
  spanProcessors?: unknown[] | null;
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
  // Emits user-facing warnings (typically diag.warn). Kept injectable so tests can count calls.
  warn: (message: string) => void;
}

// Mutates `cfg` in place: sets cfg.spanProcessors to the resolved list (existing/derived + ours) and
// removes every input the SDK would otherwise ignore. Returns the resolved list for convenience.
//
// Abort contract: when the env branch is reached and deps.envSpanProcessors() returns undefined,
// this returns undefined WITHOUT touching cfg. Setting spanProcessors to just our processor there
// would make NodeSDK skip its own env wiring and silently drop the user's span export; leaving cfg
// untouched lets NodeSDK wire export upstream-style, and only the extension stays inert.
export function normalizeSpanProcessors(cfg: NormalizeConfig, deps: NormalizeDeps): unknown[] | undefined {
  let processors: unknown[];
  if (cfg.spanProcessors) {
    // R1 (non-empty) / R2 (empty): plural wins outright, mirroring NodeSDK.
    processors = [...cfg.spanProcessors];
    if (processors.length === 0) {
      // R2: the user disabled trace export (NodeSDK builds no export for a truthy empty array).
      // Appending our processor enables span metrics without changing that choice — but spans that
      // were non-recording under the user's config alone will now be recorded (never exported).
      deps.warn(
        "[span-metrics] 'spanProcessors' is empty (trace export disabled); adding only the " +
          'span-metrics processor. Spans will be recorded for metrics but not exported.'
      );
    }
    dropLoser(cfg, deps, 'spanProcessor');
    dropLoser(cfg, deps, 'traceExporter');
  } else if (cfg.spanProcessor) {
    // R3: deprecated singular option (deprecated in sdk-node 0.51.0, 2024-04, but functional in all
    // supported eras). Honored, converted, and removed. Remove this branch when upstream does.
    deps.warn(
      "[span-metrics] the 'spanProcessor' (singular) NodeSDK option is deprecated; it was converted " +
        "to 'spanProcessors'. Please migrate to 'spanProcessors'."
    );
    processors = [cfg.spanProcessor];
    delete cfg.spanProcessor;
    dropLoser(cfg, deps, 'traceExporter');
  } else if (cfg.traceExporter) {
    // R4: wrap the lone exporter as NodeSDK would, then drop it so NodeSDK does not ignore it once
    // spanProcessors is set. Wrap BEFORE delete so a throwing wrapper cannot lose the reference.
    processors = [deps.wrapExporter(cfg.traceExporter)];
    delete cfg.traceExporter;
  } else {
    // R5/R6: nothing truthy configured (absent or null — null is not a disable signal in any era).
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

// Deletes a field that lost the precedence race. Warns only when a real user component is being
// dropped (truthy value); a null/undefined loser is cleaned up silently — it never did anything.
// Own-properties only, and delete failures (non-configurable property, strict mode) are swallowed:
// a leftover loser is inert inside NodeSDK anyway once spanProcessors is set — cleanup must never
// throw mid-transform and leave the config half-mutated.
function dropLoser(cfg: NormalizeConfig, deps: NormalizeDeps, field: 'spanProcessor' | 'traceExporter'): void {
  if (!Object.prototype.hasOwnProperty.call(cfg, field)) {
    return;
  }
  if (cfg[field]) {
    deps.warn(
      `[span-metrics] '${field}' was set alongside a winning option and is IGNORED by NodeSDK ` +
        'precedence (spanProcessors > spanProcessor > traceExporter); it was removed from the config.'
    );
  }
  try {
    delete cfg[field];
  } catch {
    // Non-configurable property: leave it — NodeSDK ignores it once spanProcessors is set.
  }
}
