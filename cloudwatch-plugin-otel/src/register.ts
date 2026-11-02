// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mode 1 (zero-code): load this via --require BEFORE
 * @opentelemetry/auto-instrumentations-node/register. It patches the NodeSDK export in the module
 * cache so upstream's register constructs our subclass, which wraps the sampler, appends the span
 * processor, and binds the MeterProvider.
 *
 * This patches non-public NodeSDK internals, so it guards on the *internal shape* it detects at
 * runtime (not on a version number): it recognizes two known NodeSDK layouts, picks the matching
 * injection strategy, and after start() verifies the extension actually took effect. If neither
 * shape is recognized, or the post-start self-check shows the extension is inert, it warns loudly
 * and leaves telemetry running with upstream behavior rather than silently mis-wiring.
 *
 * LOAD SAFETY: this module is loaded via --require, often process-wide through NODE_OPTIONS, so it
 * must never crash a host that lacks OpenTelemetry. Everything that touches an OpenTelemetry
 * package — including our own modules that import one at load time — is required LAZILY inside
 * patch(), so merely loading this file executes nothing that can throw MODULE_NOT_FOUND. Only
 * dependency-free modules may be imported statically here.
 */
import { normalizeSpanProcessors, TRACE_EXPORT_DISABLED_MESSAGE } from './internal/normalize-span-processors';

function safeVersion(pkgPath: string): string {
  try {
    return require(pkgPath).version;
  } catch {
    return 'unknown';
  }
}

function patch(): void {
  // Lazy requires (see LOAD SAFETY above): a missing @opentelemetry/api or sdk-trace-base peer
  // throws HERE, inside the guarded call, not at module load.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { diag } = require('@opentelemetry/api');
  const { AlwaysRecordSampler } = require('./always-record-sampler');
  const { SpanMetricsProcessor } = require('./span-metrics-processor');
  const holder = require('./internal/open-telemetry-holder');
  const { detectShape } = require('./internal/detect-shape');
  const { resolveEnvSamplerOrDefault } = require('./internal/env-sampler');
  /* eslint-enable @typescript-eslint/no-var-requires */

  // Best-effort check that a SpanMetricsProcessor ended up in the built tracer provider's active
  // processor set. Reads a private composite (_activeSpanProcessor._spanProcessors); if the
  // internals aren't in the expected shape we return true (don't cry wolf on an introspection miss —
  // the shape probe already gated us, and this is a secondary safety net, not the primary guard).
  function spanMetricsProcessorAttached(sdkInstance: Record<string, any>): boolean {
    try {
      const tp = sdkInstance._tracerProvider;
      const composite = tp && tp._activeSpanProcessor;
      const list = composite && composite._spanProcessors;
      if (!Array.isArray(list)) {
        return true; // unknown internal shape — don't emit a false warning
      }
      return list.some(p => p instanceof SpanMetricsProcessor);
    } catch {
      return true;
    }
  }

  // auto-instrumentations-node may resolve its OWN nested copy of sdk-node, which is a different
  // module instance than a bare require('@opentelemetry/sdk-node') from here. Patch the SAME copy
  // upstream will construct by resolving sdk-node relative to auto-instrumentations-node.
  let sdkNodePath: string;
  let pkgPath: string;
  try {
    const autoInstrEntry = require.resolve('@opentelemetry/auto-instrumentations-node');
    sdkNodePath = require.resolve('@opentelemetry/sdk-node', { paths: [autoInstrEntry] });
    pkgPath = require.resolve('@opentelemetry/sdk-node/package.json', { paths: [autoInstrEntry] });
  } catch {
    // Fall back to our own resolution (e.g. manual/programmatic users without auto-instrumentations).
    sdkNodePath = require.resolve('@opentelemetry/sdk-node');
    pkgPath = require.resolve('@opentelemetry/sdk-node/package.json');
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdkNode = require(sdkNodePath);
  const version: string = safeVersion(pkgPath);
  const OriginalNodeSDK = sdkNode.NodeSDK;

  // Detect the internal shape by probing the class source rather than matching a version number.
  // A version allowlist both rejects new-but-compatible versions and accepts a version whose
  // internals silently shifted; probing the actual layout self-adapts and is verified again after
  // start().
  const shape = detectShape(OriginalNodeSDK, version);
  if (shape === 'UNKNOWN') {
    diag.warn(
      `[span-metrics] unrecognized @opentelemetry/sdk-node internal layout (version ${version}); ` +
        'span metrics are DISABLED to avoid mis-wiring. Traces/metrics continue with upstream ' +
        'behavior. This usually means sdk-node changed internals — update the extension.'
    );
    return;
  }
  const isConfigShape = shape === 'CONFIG';

  // Env span processors the SDK would build when the user configured none (zero-code). Resolved from
  // the same sdk-node copy the SDK uses, so exporting keeps working after we add our processor.
  //
  // Returns undefined when the SDK's env-processor helper cannot be reached (it lives at a
  // non-public build/src path that may move between sdk-node versions). Callers must treat
  // undefined as "do NOT normalize": forcing an empty list instead would make NodeSDK see an
  // explicit spanProcessors, skip its own env wiring, and silently drop the user's span export
  // while our 100% metrics masked the loss. If this path breaks, the extension gives itself up —
  // the user keeps their traces, and the post-start self-verify reports metrics inactive.
  function envSpanProcessors(): unknown[] | undefined {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const utils = require(require.resolve('@opentelemetry/sdk-node/build/src/utils', { paths: [sdkNodePath] }));
      if (typeof utils.getSpanProcessorsFromEnv !== 'function') {
        diag.warn(
          '[span-metrics] sdk-node env-processor helper not found; span metrics are DISABLED for ' +
            'this SDK so span export continues with upstream behavior.'
        );
        return undefined;
      }
      return utils.getSpanProcessorsFromEnv();
    } catch (e) {
      diag.warn(
        '[span-metrics] failed to resolve sdk-node env processors; span metrics are DISABLED for ' +
          'this SDK so span export continues with upstream behavior.',
        e
      );
      return undefined;
    }
  }

  // Wrap a traceExporter in a BatchSpanProcessor from the SAME sdk-trace-base copy the SDK uses,
  // mirroring how NodeSDK itself would wrap a lone traceExporter.
  function batchProcessorFor(exporter: unknown): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const base = require(require.resolve('@opentelemetry/sdk-trace-base', { paths: [sdkNodePath] }));
    return new base.BatchSpanProcessor(exporter);
  }

  class SpanMetricsNodeSDK extends OriginalNodeSDK {
    constructor(config: Record<string, any> = {}) {
      // Wrap the sampler before super() so the wrapped one is what the SDK builds with. Programmatic
      // users pass config.sampler; zero-code register users configure it via OTEL_TRACES_SAMPLER
      // (+_ARG). Resolve the env sampler when neither is set, falling back to the SDK's own default
      // (ParentBased(AlwaysOn)) so record-forcing applies in all cases — never leaving spans
      // un-forced (which would undercount metrics).
      try {
        const base = config.sampler ?? resolveEnvSamplerOrDefault();
        config.sampler = AlwaysRecordSampler.create(base);
      } catch (e) {
        diag.error('[span-metrics] failed to wrap sampler; continuing without record-forcing', e);
      }
      super(config);

      if (!isConfigShape) {
        // Field shape (<= 0.219): the constructor may have assembled _tracerProviderConfig from an
        // explicit exporter/processor config. Append ours there; the env-driven case (no field) is
        // handled in start(). An EMPTY processor list means trace export is disabled — upstream
        // registers no tracer provider for it, and adding only ours would create a recording
        // provider that changes trace-context propagation downstream. Abort in that case.
        try {
          const tpConfig = (this as Record<string, any>)._tracerProviderConfig;
          if (tpConfig) {
            const existing = tpConfig.spanProcessors ?? [];
            if (existing.length === 0) {
              diag.warn(TRACE_EXPORT_DISABLED_MESSAGE);
              (this as Record<string, any>)._spanMetricsAborted = true;
            } else {
              tpConfig.spanProcessors = [...existing, new SpanMetricsProcessor()];
            }
          }
        } catch (e) {
          diag.error('[span-metrics] failed to append processor at construction', e);
        }
      }
    }

    start(): void {
      // Aborted = the extension deliberately gave itself up before start (trace export disabled, or
      // env processors unresolvable). Every abort path has already emitted its own warning, so the
      // post-start self-verify below must stay silent: its introspection defaults would otherwise
      // log "active" right after the DISABLED warning (spanMetricsProcessorAttached returns true
      // when no tracer provider exists at all).
      let aborted = (this as Record<string, any>)._spanMetricsAborted === true;
      try {
        const self = this as Record<string, any>;
        if (isConfigShape) {
          // Config shape (>= 0.220): start() derives spanProcessors from this._configuration.
          // Normalize that to an explicit spanProcessors list with ours appended, preserving export.
          const cfg = self._configuration ?? (self._configuration = {});
          const normalized = normalizeSpanProcessors(cfg, {
            makeSpanMetricsProcessor: () => new SpanMetricsProcessor(),
            wrapExporter: batchProcessorFor,
            envSpanProcessors,
            warn: message => diag.warn(message),
          });
          if (normalized === undefined) {
            aborted = true;
          }
        } else if (!self._tracerProviderConfig) {
          // Field shape, env-driven (zero-code): constructor built no _tracerProviderConfig. Build one
          // carrying env processors + ours so start()'s field-or-env branch includes it. If the env
          // processors cannot be resolved, leave the field unset so NodeSDK does its own env wiring
          // rather than replacing the user's export.
          const envProcessors = envSpanProcessors();
          if (envProcessors === undefined) {
            aborted = true;
          } else if (envProcessors.length === 0) {
            // OTEL_TRACES_EXPORTER=none: trace export disabled — upstream would register no
            // tracer provider. Building one carrying only our processor would change propagation
            // downstream, so leave the field unset and stay inert.
            diag.warn(TRACE_EXPORT_DISABLED_MESSAGE);
            aborted = true;
          } else {
            self._tracerProviderConfig = {
              spanProcessors: [...envProcessors, new SpanMetricsProcessor()],
            };
          }
        }
      } catch (e) {
        diag.error('[span-metrics] failed to inject processor before start()', e);
      }

      super.start();

      // The extension is deliberately inert and has already said so — no self-verify, no bind, no
      // "active" claim.
      if (aborted) {
        return;
      }

      // Self-verification: confirm the extension actually took effect, rather than assuming the
      // shape-based injection worked. Catches "wired but inert" regardless of sdk-node version — the
      // safety net that lets us drop the version allowlist. Two checks:
      const self = this as Record<string, any>;

      // 1. Our processor is present in the built tracer provider's active processor set.
      const attached = spanMetricsProcessorAttached(self);
      if (!attached) {
        diag.warn(
          '[span-metrics] the span-metrics processor does not appear to be attached after start(); ' +
            'span metrics may be inactive. This can indicate an unrecognized sdk-node internal change.'
        );
      }

      // 2. A MeterProvider exists to record into; bind it so the processor can emit.
      const mp = self._meterProvider;
      if (mp) {
        holder.set(mp);
        // Only claim "active" when the attach check also passed — announcing active right after an
        // injection failure warned would be contradictory and mislead operators grepping logs.
        if (attached) {
          diag.info('[span-metrics] active; RED metrics reflect 100% of spans');
        }
      } else {
        diag.warn(
          '[span-metrics] no MeterProvider after start(); set OTEL_METRICS_EXPORTER (and ' +
            'OTEL_NODE_EXPERIMENTAL_SDK_METRICS if required). RED metrics will not be exported.'
        );
      }
    }
  }

  Object.defineProperty(sdkNode, 'NodeSDK', {
    enumerable: true,
    configurable: true,
    get: () => SpanMetricsNodeSDK,
  });
  diag.info('[span-metrics] NodeSDK patched');
}

// A telemetry add-on must never crash the host. This module is loaded via --require (often set
// process-wide through NODE_OPTIONS), so an escaping exception here — e.g. MODULE_NOT_FOUND when
// @opentelemetry/sdk-node is absent (a devDependency of this package) or when even the
// @opentelemetry/api peer is missing — would abort EVERY Node process on the box at startup,
// including ones unrelated to telemetry. Degrade to a no-op instead: skip the patch, warn, and
// leave upstream behavior intact.
try {
  patch();
} catch (e) {
  const message =
    '[span-metrics] initialization failed (are the OpenTelemetry packages installed?); ' +
    'span metrics are DISABLED. Traces/metrics continue with upstream behavior.';
  // Coerce defensively: String(e) itself throws for values with no primitive coercion (e.g. a
  // thrown null-prototype object), which would re-crash the host this guard exists to protect.
  let detail: string;
  try {
    detail = e instanceof Error ? e.message : String(e);
  } catch {
    detail = '(unprintable error)';
  }
  // diag itself lives in @opentelemetry/api, which may be exactly what failed to resolve — the
  // attempt must not be allowed to re-throw. stderr below is the unconditional channel.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('@opentelemetry/api').diag.warn(message, e);
  } catch {
    // api unavailable — stderr only.
  }
  // Also write to stderr: at --require time no DiagLogger is installed yet (upstream register has
  // not run), so diag.warn alone is invisible. stderr is the only channel guaranteed to surface.
  process.stderr.write(`${message} ${detail}\n`);
}
