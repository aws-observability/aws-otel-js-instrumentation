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

// Resolve the sampler the SDK would build from OTEL_TRACES_SAMPLER(+_ARG), using the same
// sdk-trace-base copy the SDK uses, so our wrapper delegates to the user's configured sampler.
// Mirrors the OTel env sampler mapping; defaults to ParentBased(AlwaysOn) like the SDK.
function resolveEnvSampler(sdkNodePath: string): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const base = require(require.resolve('@opentelemetry/sdk-trace-base', { paths: [sdkNodePath] }));
  const { ParentBasedSampler, AlwaysOnSampler, AlwaysOffSampler, TraceIdRatioBasedSampler } = base;
  const name = process.env.OTEL_TRACES_SAMPLER;
  const argRaw = process.env.OTEL_TRACES_SAMPLER_ARG;
  const ratio = argRaw !== undefined && argRaw !== '' ? Number(argRaw) : 1;
  switch (name) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratio);
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
    case 'parentbased_always_on':
    default:
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

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
  function envSpanProcessors(): any[] {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const utils = require(require.resolve('@opentelemetry/sdk-node/build/src/utils', { paths: [sdkNodePath] }));
      return utils.getSpanProcessorsFromEnv ? utils.getSpanProcessorsFromEnv() : [];
    } catch {
      return [];
    }
  }

  class SpanMetricsNodeSDK extends OriginalNodeSDK {
    constructor(config: Record<string, any> = {}) {
      // Wrap the sampler before super() so the wrapped one is what the SDK builds with. Programmatic
      // users pass config.sampler; zero-code register users configure it via OTEL_TRACES_SAMPLER
      // (+_ARG), which we resolve and wrap here, so record-forcing applies in all cases. If neither
      // is set, the delegate is the SDK's own default (ParentBased(AlwaysOn)).
      try {
        const base = config.sampler ?? resolveEnvSampler(sdkNodePath);
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
          // Config shape (>= 0.220): start() derives spanProcessors from this._configuration
          // (spanProcessors ?? [spanProcessor] ?? [batch(traceExporter)] ?? env). Normalize that to
          // an explicit spanProcessors list with ours appended, so exporting is preserved.
          const cfg = self._configuration ?? (self._configuration = {});
          let processors: any[];
          if (cfg.spanProcessors) {
            processors = [...cfg.spanProcessors];
          } else if (cfg.spanProcessor) {
            processors = [cfg.spanProcessor];
            delete cfg.spanProcessor;
          } else {
            // traceExporter / env: let the SDK's own env resolution stand, then add ours. (A lone
            // traceExporter is rare for register users, who are env-driven; env is the common path.)
            processors = envSpanProcessors();
          }
          processors.push(new SpanMetricsProcessor());
          cfg.spanProcessors = processors;
        } else if (!self._tracerProviderConfig) {
          // Field shape, env-driven (zero-code): constructor built no _tracerProviderConfig. Build one
          // carrying env processors + ours so start()'s field-or-env branch includes it.
          self._tracerProviderConfig = {
            spanProcessors: [...envSpanProcessors(), new SpanMetricsProcessor()],
          };
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
      if (!spanMetricsProcessorAttached(self)) {
        diag.warn(
          '[span-metrics] the span-metrics processor does not appear to be attached after start(); ' +
            'span metrics may be inactive. This can indicate an unrecognized sdk-node internal change.'
        );
      }

      // 2. A MeterProvider exists to record into; bind it so the processor can emit.
      const mp = self._meterProvider;
      if (mp) {
        holder.set(mp);
        diag.info('[span-metrics] active; RED metrics reflect 100% of spans');
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

patch();
