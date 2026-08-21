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
 */
import { diag } from '@opentelemetry/api';
import { AlwaysRecordSampler } from './always-record-sampler';
import { SpanMetricsProcessor } from './span-metrics-processor';
import * as holder from './internal/open-telemetry-holder';
import { detectShape } from './internal/detect-shape';
import { normalizeSpanProcessors } from './internal/normalize-span-processors';
import { resolveEnvSamplerOrDefault } from './internal/env-sampler';

function safeVersion(pkgPath: string): string {
  try {
    return require(pkgPath).version;
  } catch {
    return 'unknown';
  }
}

// Best-effort check that a SpanMetricsProcessor ended up in the built tracer provider's active
// processor set. Reads a private composite (_activeSpanProcessor._spanProcessors); if the internals
// aren't in the expected shape we return true (don't cry wolf on an introspection miss — the shape
// probe already gated us, and this is a secondary safety net, not the primary guard).
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

function patch(): void {
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

  // Detect the internal shape by probing a throwaway instance rather than matching a version number.
  // A version allowlist both rejects new-but-compatible versions and accepts a version whose
  // internals silently shifted; probing the actual layout self-adapts and is verified again after
  // start(). The probe passes a minimal trace config so the FIELD-shape constructor populates
  // _tracerProviderConfig; CONFIG-shape leaves that undefined and exposes _configuration instead.
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
        // handled in start().
        try {
          const tpConfig = (this as Record<string, any>)._tracerProviderConfig;
          if (tpConfig) {
            tpConfig.spanProcessors = [...(tpConfig.spanProcessors ?? []), new SpanMetricsProcessor()];
          }
        } catch (e) {
          diag.error('[span-metrics] failed to append processor at construction', e);
        }
      }
    }

    start(): void {
      try {
        const self = this as Record<string, any>;
        if (isConfigShape) {
          // Config shape (>= 0.220): start() derives spanProcessors from this._configuration.
          // Normalize that to an explicit spanProcessors list with ours appended, preserving export.
          const cfg = self._configuration ?? (self._configuration = {});
          normalizeSpanProcessors(cfg, {
            makeSpanMetricsProcessor: () => new SpanMetricsProcessor(),
            wrapExporter: batchProcessorFor,
            envSpanProcessors,
          });
        } else if (!self._tracerProviderConfig) {
          // Field shape, env-driven (zero-code): constructor built no _tracerProviderConfig. Build one
          // carrying env processors + ours so start()'s field-or-env branch includes it. If the env
          // processors cannot be resolved, leave the field unset so NodeSDK does its own env wiring
          // (we lose metrics; the self-verify below warns) rather than replacing the user's export.
          const envProcessors = envSpanProcessors();
          if (envProcessors !== undefined) {
            self._tracerProviderConfig = {
              spanProcessors: [...envProcessors, new SpanMetricsProcessor()],
            };
          }
        }
      } catch (e) {
        diag.error('[span-metrics] failed to inject processor before start()', e);
      }

      super.start();

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
// @opentelemetry/sdk-node is absent, which is a devDependency of this package, not a transitive
// one — would abort EVERY Node process on the box at startup, including ones unrelated to
// telemetry. Degrade to a no-op instead: skip the patch, warn, and leave upstream behavior intact.
try {
  patch();
} catch (e) {
  const message =
    '[span-metrics] initialization failed (is @opentelemetry/sdk-node installed?); ' +
    'span metrics are DISABLED. Traces/metrics continue with upstream behavior.';
  // Coerce defensively: String(e) itself throws for values with no primitive coercion (e.g. a
  // thrown null-prototype object), which would re-crash the host this guard exists to protect.
  let detail: string;
  try {
    detail = e instanceof Error ? e.message : String(e);
  } catch {
    detail = '(unprintable error)';
  }
  diag.warn(message, e);
  // Also write to stderr: at --require time no DiagLogger is installed yet (upstream register has
  // not run), so diag.warn alone is invisible. stderr is the only channel guaranteed to surface.
  process.stderr.write(`${message} ${detail}\n`);
}
