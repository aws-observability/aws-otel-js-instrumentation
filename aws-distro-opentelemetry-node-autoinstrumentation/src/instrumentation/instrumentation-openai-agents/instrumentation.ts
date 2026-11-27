// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Context, context } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from '@opentelemetry/instrumentation';
import { LIB_VERSION } from '../../version';
import { OpenAIAgentsInstrumentationConfig } from './types';
import { OpenTelemetryTracingProcessor } from './tracing-processor';
import {
  isAgenticInstrumentationOptIn,
  isInstrumentationDisabled,
  detectConflictingInstrumentation,
} from '../../utils';
import { tryWrap, tryUnwrap } from '../common/instrumentation-utils';

export const INSTRUMENTATION_NAME = '@aws/aws-distro-opentelemetry-instrumentation-openai-agents';
export const INSTRUMENTATION_SHORT_NAME = 'aws_openai_agents';

const SUPPORTED_VERSIONS = ['>=0.1.0'];
const TRACE_SCOPE_FUNCTIONS = ['withTrace', 'getOrCreateTrace'];

// The SDK tracks its current span with AsyncLocalStorage.enterWith, which OTel context cannot follow.
// Streamed model calls start their span that way inside an async generator driven by a detached
// stream loop, so HTTP calls made while reading the stream would otherwise have no parent.
// This context resolves the OTel context of the SDK's current span on every lookup.
// see: https://github.com/openai/openai-agents-js/blob/v0.8.5/packages/agents-core/src/tracing/context.ts#L148-L160
class SdkCurrentSpanContext implements Context {
  constructor(private readonly _base: Context, private readonly _resolve: () => Context | undefined) {}

  private _current(): Context {
    return this._resolve() ?? this._base;
  }

  getValue(key: symbol): unknown {
    return this._current().getValue(key);
  }

  setValue(key: symbol, value: unknown): Context {
    return this._current().setValue(key, value);
  }

  deleteValue(key: symbol): Context {
    return this._current().deleteValue(key);
  }
}

export class OpenAIAgentsInstrumentation extends InstrumentationBase<OpenAIAgentsInstrumentationConfig> {
  // OpenAI Agents SDK has its own tracing system that is completely separate from OTel.
  //
  // We register our custom OpenTelemetryTracingProcessor on the global TraceProvider
  // to receive span events and translate them into OTel spans.
  _processor?: OpenTelemetryTracingProcessor;
  private _patchedProvider: any;

  constructor(config: OpenAIAgentsInstrumentationConfig = {}) {
    super(INSTRUMENTATION_NAME, LIB_VERSION, config);
  }

  override setConfig(config: OpenAIAgentsInstrumentationConfig = {}) {
    super.setConfig({ ...config, captureMessageContent: !!config.captureMessageContent });
  }

  override enable() {
    if (isInstrumentationDisabled(INSTRUMENTATION_SHORT_NAME)) {
      this._diag.debug(`${INSTRUMENTATION_NAME} is disabled`);
      return;
    }

    if (!isAgenticInstrumentationOptIn()) {
      const conflict = detectConflictingInstrumentation(INSTRUMENTATION_SHORT_NAME);
      if (conflict) {
        this._diag.info(
          `Skipping ${INSTRUMENTATION_NAME}: third-party '${conflict}' detected. ` +
            'Set AWS_AGENTIC_INSTRUMENTATION_OPT_IN=true to override.'
        );
        return;
      }
    }
    super.enable();
  }

  override _updateMetricInstruments() {}

  protected init() {
    const patchCore = (moduleExports: any) => this._wrapSdkTraceProvider(moduleExports);
    const unpatchCore = (_moduleExports: any) => this._unpatch();
    const patchCreateSpans = (moduleExports: any) => this._wrapCreateSpansWithOtelContext(moduleExports);
    const unpatchCreateSpans = (moduleExports: any) => this._unwrapCreateSpansWithOtelContext(moduleExports);
    const patchContext = (moduleExports: any) => this._wrapTraceScopesWithSdkContext(moduleExports);
    const unpatchContext = (moduleExports: any) => this._unwrapTraceScopesWithSdkContext(moduleExports);

    return [
      new InstrumentationNodeModuleDefinition('@openai/agents-core', SUPPORTED_VERSIONS, patchCore, unpatchCore, [
        new InstrumentationNodeModuleFile(
          '@openai/agents-core/dist/tracing/createSpans.mjs',
          SUPPORTED_VERSIONS,
          patchCreateSpans,
          unpatchCreateSpans
        ),
        new InstrumentationNodeModuleFile(
          '@openai/agents-core/dist/tracing/createSpans.js',
          SUPPORTED_VERSIONS,
          patchCreateSpans,
          unpatchCreateSpans
        ),
        new InstrumentationNodeModuleFile(
          '@openai/agents-core/dist/tracing/context.mjs',
          SUPPORTED_VERSIONS,
          patchContext,
          unpatchContext
        ),
        new InstrumentationNodeModuleFile(
          '@openai/agents-core/dist/tracing/context.js',
          SUPPORTED_VERSIONS,
          patchContext,
          unpatchContext
        ),
      ]),
    ];
  }

  private _wrapSdkTraceProvider(moduleExports: any): any {
    // wraps SDK's (OpenAI's not OTel) global TraceProvider to register our OTel processor
    // and ensure it survives when the SDK replaces processors at import time.
    if (this._patchedProvider) return moduleExports;

    const getGlobalTraceProvider = moduleExports.getGlobalTraceProvider;
    if (typeof getGlobalTraceProvider !== 'function') {
      this._diag.warn('Could not find getGlobalTraceProvider on @openai/agents-core');
      return moduleExports;
    }

    const provider = getGlobalTraceProvider();
    const captureContent = !!this.getConfig().captureMessageContent;
    this._processor = new OpenTelemetryTracingProcessor(this.tracer, captureContent);

    if (typeof provider.addProcessor === 'function') {
      provider.addProcessor(this._processor);
    }

    const processor = this._processor;

    // setProcessors replaces all registered processors and shuts down the old ones.
    // setProcessors is called at import time to register its own exporter
    // which would remove our processor. We patch it to always keep ours in the list.
    // see: https://github.com/openai/openai-agents-js/blob/v0.8.5/packages/agents-core/src/tracing/processor.ts#L271-L277
    // see: https://github.com/openai/openai-agents-js/blob/v0.8.5/packages/agents/src/index.ts#L8
    tryWrap(
      () =>
        this._wrap(provider, 'setProcessors', (original: any) => {
          return function (this: any, _processors: any[]) {
            original.call(this, [processor]);
            processor.enable();
          };
        }),
      'OpenAI Agents TraceProvider.setProcessors'
    );

    // The built-in onSpanStart is no-op so we never get notified when spans start.
    // We patch createSpan to call our processor.onSpanStart so we can create OTel spans at the right time.
    // see: https://github.com/openai/openai-agents-js/blob/v0.8.5/packages/agents-core/src/tracing/processor.ts#L209-L211
    tryWrap(
      () =>
        this._wrap(provider, 'createSpan', (original: any) => {
          return function (this: any, spanOptions: any, parent: any) {
            const span = original.call(this, spanOptions, parent);
            if (!processor.disabled && span.spanId !== 'no-op') {
              void processor.onSpanStart(span);
            }
            return span;
          };
        }),
      'OpenAI Agents TraceProvider.createSpan'
    );

    this._patchedProvider = provider;
    this._diag.debug('Patched global TraceProvider');
    return moduleExports;
  }

  // The withSpan functions run callbacks inside the SDK's own context
  // which is separate from OTel context. We wrap them with context.with to make the OTel span
  // active during the callback so downstream instrumentations see the correct parent.
  // see: https://github.com/openai/openai-agents-js/blob/v0.8.5/packages/agents-core/src/tracing/createSpans.ts#L27-L54
  private _wrapCreateSpansWithOtelContext(moduleExports: any): any {
    const instrumentation = this;

    for (const key of Object.keys(moduleExports)) {
      if (typeof moduleExports[key] !== 'function') continue;
      if (!key.match(/^with\w+Span$/)) continue;

      tryWrap(
        () =>
          this._wrap(moduleExports, key, (original: any) => {
            return function (this: any, fn: any, ...rest: any[]) {
              return original.call(
                this,
                (sdkSpan: any) => {
                  const processor = instrumentation._processor;
                  if (!processor || processor.disabled) return fn(sdkSpan);

                  const otelCtx = processor.getOtelContext(sdkSpan.spanId);
                  if (!otelCtx) return fn(sdkSpan);

                  return context.with(otelCtx, () => fn(sdkSpan));
                },
                ...rest
              );
            };
          }),
        `OpenAI Agents ${key}`
      );
    }

    return moduleExports;
  }

  private _unwrapCreateSpansWithOtelContext(moduleExports: any): void {
    for (const key of Object.keys(moduleExports)) {
      if (typeof moduleExports[key] !== 'function') continue;
      if (!key.match(/^with\w+Span$/)) continue;
      tryUnwrap(() => this._unwrap(moduleExports, key), `OpenAI Agents ${key}`);
    }
  }

  // Runs each SDK trace scope (every Runner.run goes through one) in an SdkCurrentSpanContext, so
  // code the SDK runs outside the withSpan callbacks, such as streamed model calls, still sees
  // the OTel span of the SDK's current span, or the workflow span when no SDK span is current.
  private _wrapTraceScopesWithSdkContext(moduleExports: any): any {
    const instrumentation = this;
    const getCurrentSpan = moduleExports.getCurrentSpan;
    const getCurrentTrace = moduleExports.getCurrentTrace;
    if (typeof getCurrentSpan !== 'function' || typeof getCurrentTrace !== 'function') {
      this._diag.warn('Could not find getCurrentSpan/getCurrentTrace on @openai/agents-core tracing context');
      return moduleExports;
    }

    const resolveSdkContext = (): Context | undefined => {
      const processor = instrumentation._processor;
      if (!processor || processor.disabled) return undefined;
      const sdkSpan = getCurrentSpan();
      const spanContext = sdkSpan ? processor.getOtelContext(sdkSpan.spanId) : undefined;
      if (spanContext) return spanContext;
      const sdkTrace = getCurrentTrace();
      return sdkTrace ? processor.getWorkflowOtelContext(sdkTrace.traceId) : undefined;
    };

    for (const key of TRACE_SCOPE_FUNCTIONS) {
      if (typeof moduleExports[key] !== 'function') continue;
      tryWrap(
        () =>
          this._wrap(moduleExports, key, (original: any) => {
            return function (this: any, ...args: any[]) {
              // withTrace(trace, fn, options) and getOrCreateTrace(fn, options)
              const fnIndex = key === 'withTrace' ? 1 : 0;
              const fn = args[fnIndex];
              if (typeof fn !== 'function') return original.apply(this, args);

              const sdkContext = new SdkCurrentSpanContext(context.active(), resolveSdkContext);
              args[fnIndex] = function (this: any, ...fnArgs: any[]) {
                return context.with(sdkContext, () => fn.apply(this, fnArgs));
              };
              return original.apply(this, args);
            };
          }),
        `OpenAI Agents ${key}`
      );
    }

    return moduleExports;
  }

  private _unwrapTraceScopesWithSdkContext(moduleExports: any): void {
    for (const key of TRACE_SCOPE_FUNCTIONS) {
      if (typeof moduleExports[key] !== 'function') continue;
      tryUnwrap(() => this._unwrap(moduleExports, key), `OpenAI Agents ${key}`);
    }
  }

  private _unpatch(): void {
    if (this._patchedProvider) {
      tryUnwrap(() => this._unwrap(this._patchedProvider, 'createSpan'), 'OpenAI Agents TraceProvider.createSpan');
      tryUnwrap(
        () => this._unwrap(this._patchedProvider, 'setProcessors'),
        'OpenAI Agents TraceProvider.setProcessors'
      );
    }
    if (this._processor) {
      this._processor.disable();
      this._processor = undefined;
    }
    this._patchedProvider = undefined;
  }
}
