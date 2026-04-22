// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { context } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
} from '@opentelemetry/instrumentation';
import { LIB_VERSION } from '../../version';
import { OpenAIAgentsInstrumentationConfig } from './types';
import { OpenTelemetryTracingProcessor } from './tracing-processor';

export const INSTRUMENTATION_NAME = '@aws/aws-distro-opentelemetry-instrumentation-openai-agents';

const SUPPORTED_VERSIONS = ['>=0.1.0'];

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

  override _updateMetricInstruments() {}

  protected init() {
    const patchCore = (moduleExports: any) => this._wrapSdkTraceProvider(moduleExports);
    const unpatchCore = (_moduleExports: any) => this._unpatch();
    const patchCreateSpans = (moduleExports: any) => this._wrapCreateSpansWithOtelContext(moduleExports);
    const unpatchCreateSpans = (moduleExports: any) => this._unwrapCreateSpansWithOtelContext(moduleExports);

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

    if (isWrapped(provider.setProcessors) || isWrapped(provider.createSpan)) {
      this._diag.info('OpenAI Agents TraceProvider is already wrapped by another instrumentor, skipping');
      return moduleExports;
    }

    // setProcessors replaces all registered processors and shuts down the old ones.
    // setProcessors is called at import time to register its own exporter
    // which would remove our processor. We patch it to always keep ours in the list.
    // see: https://github.com/openai/openai-agents-js/blob/v0.8.5/packages/agents-core/src/tracing/processor.ts#L271-L277
    // see: https://github.com/openai/openai-agents-js/blob/v0.8.5/packages/agents/src/index.ts#L8
    this._wrap(provider, 'setProcessors', (original: any) => {
      return function (this: any, _processors: any[]) {
        original.call(this, [processor]);
        processor.enable();
      };
    });

    // The built-in onSpanStart is no-op so we never get notified when spans start.
    // We patch createSpan to call our processor.onSpanStart so we can create OTel spans at the right time.
    // see: https://github.com/openai/openai-agents-js/blob/v0.8.5/packages/agents-core/src/tracing/processor.ts#L209-L211
    this._wrap(provider, 'createSpan', (original: any) => {
      return function (this: any, spanOptions: any, parent: any) {
        const span = original.call(this, spanOptions, parent);
        if (!processor.disabled && span.spanId !== 'no-op') {
          void processor.onSpanStart(span);
        }
        return span;
      };
    });

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

      if (isWrapped(moduleExports[key])) {
        this._diag.info(`${key} is already wrapped by another instrumentor, skipping`);
        continue;
      }

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
      });
    }

    return moduleExports;
  }

  private _unwrapCreateSpansWithOtelContext(moduleExports: any): void {
    for (const key of Object.keys(moduleExports)) {
      if (typeof moduleExports[key] !== 'function') continue;
      if (!key.match(/^with\w+Span$/)) continue;
      this._unwrap(moduleExports, key);
    }
  }

  private _unpatch(): void {
    if (this._patchedProvider) {
      this._unwrap(this._patchedProvider, 'createSpan');
      this._unwrap(this._patchedProvider, 'setProcessors');
    }
    if (this._processor) {
      this._processor.disable();
      this._processor = undefined;
    }
    this._patchedProvider = undefined;
  }
}
