// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { context } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from '@opentelemetry/instrumentation';
import { LIB_VERSION } from '../../version';
import { OpenAIAgentsInstrumentationConfig } from './types';
import { OtelTracingProcessor } from './tracing-processor';

export const INSTRUMENTATION_NAME = '@aws/aws-distro-opentelemetry-instrumentation-openai-agents';

const SUPPORTED_VERSIONS = ['>=0.1.0'];

export class OpenAIAgentsInstrumentation extends InstrumentationBase<OpenAIAgentsInstrumentationConfig> {
  _processor?: OtelTracingProcessor;
  private _patchedProvider: any;

  constructor(config: OpenAIAgentsInstrumentationConfig = {}) {
    super(INSTRUMENTATION_NAME, LIB_VERSION, config);
  }

  override setConfig(config: OpenAIAgentsInstrumentationConfig = {}) {
    super.setConfig({ ...config, captureMessageContent: !!config.captureMessageContent });
  }

  override _updateMetricInstruments() {}

  protected init() {
    const patchCore = (moduleExports: any) => this._patchCore(moduleExports);
    const unpatchCore = (_moduleExports: any) => this._unpatch();
    const patchCreateSpans = (moduleExports: any) => this._patchCreateSpans(moduleExports);
    const unpatchCreateSpans = (moduleExports: any) => this._unpatchCreateSpans(moduleExports);

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

  private _patchCore(moduleExports: any): any {
    if (this._patchedProvider) return moduleExports;

    const getGlobalTraceProvider = moduleExports.getGlobalTraceProvider;
    if (typeof getGlobalTraceProvider !== 'function') {
      this._diag.warn('Could not find getGlobalTraceProvider on @openai/agents-core');
      return moduleExports;
    }

    const provider = getGlobalTraceProvider();
    const captureContent = !!this.getConfig().captureMessageContent;
    this._processor = new OtelTracingProcessor(this.tracer, captureContent);

    if (typeof provider.addProcessor === 'function') {
      provider.addProcessor(this._processor);
    }

    const processor = this._processor;

    this._wrap(provider, 'setProcessors', (original: any) => {
      return function (this: any, _processors: any[]) {
        original.call(this, [processor]);
        processor.enable();
      };
    });

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

  private _patchCreateSpans(moduleExports: any): any {
    const instrumentation = this;

    for (const key of Object.keys(moduleExports)) {
      if (typeof moduleExports[key] !== 'function') continue;
      if (!key.match(/^with\w+Span$/)) continue;

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

  private _unpatchCreateSpans(moduleExports: any): void {
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
