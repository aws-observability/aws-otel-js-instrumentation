// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { types } from 'util';
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { LIB_VERSION } from '../../version';
import { VercelAIInstrumentationConfig } from './types';
import { VercelAISpanProcessor } from './span-processor';

export const INSTRUMENTATION_NAME = '@aws/aws-distro-opentelemetry-instrumentation-vercel-ai';

const SUPPORTED_VERSIONS = ['>=3.3.0 <7.0.0'];

export class VercelAIInstrumentation extends InstrumentationBase<VercelAIInstrumentationConfig> {
  // The Vercel AI SDK has built in OTel support but telemetry is disabled by default.
  // When disabled, getTracer returns a noopTracer that silently drops all spans.
  // see: https://github.com/vercel/ai/blob/6a06fde/packages/ai/core/telemetry/get-tracer.ts#L4-L13
  //
  // Users must opt in on every call by setting experimental_telemetry.isEnabled = true,
  // which defeats the purpose of auto instrumentation.
  // see: https://github.com/vercel/ai/blob/6a06fde/packages/ai/core/generate-text/generate-text.ts#L89
  //
  // This instrumentation patches generateText, streamText, generateObject, and streamObject
  // to always inject telemetry enablement so spans are created without user code changes.
  // It also registers a VercelAISpanProcessor that translates Vercel ai.* span attributes
  // into standard OTel GenAI semantic conventions.
  // see: https://ai-sdk.dev/docs/ai-sdk-core/telemetry#semantic-conventions
  private static readonly PATCHED_FUNCTIONS: string[] = [
    'generateText',
    'streamText',
    'generateObject',
    'streamObject',
  ];
  private _patchedExports: any;
  private _spanProcessorRegistered: boolean = false;

  constructor(config: VercelAIInstrumentationConfig = {}) {
    super(INSTRUMENTATION_NAME, LIB_VERSION, config);
  }

  override setConfig(config: VercelAIInstrumentationConfig = {}) {
    super.setConfig({ ...config, captureMessageContent: !!config.captureMessageContent });
  }

  override setTracerProvider(provider: any): void {
    if (!this._spanProcessorRegistered) {
      const delegate = provider.getDelegate?.() ?? provider;
      const processors = delegate._activeSpanProcessor?._spanProcessors;

      if (!Array.isArray(processors)) {
        this._diag.warn('Failed to register VercelAISpanProcessor');
      } else {
        processors.unshift(new VercelAISpanProcessor());
        this._spanProcessorRegistered = true;
        this._diag.debug('Registered VercelAISpanProcessor');
      }
    }

    super.setTracerProvider(provider);
  }

  override _updateMetricInstruments() {}

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        'ai',
        SUPPORTED_VERSIONS,
        (moduleExports: any) => this._patch(moduleExports),
        (_moduleExports: any) => this._unpatch()
      ),
    ];
  }

  private _patch(moduleExports: any): any {
    // CJS exports from the ai package have non-configurable properties so _wrap would fail.
    // We copy them into a plain object to make them writable. ESM exports are proxied and wrappable directly.
    const isESM = types.isProxy(moduleExports);
    const exports = isESM ? moduleExports : { ...moduleExports };

    for (const fnName of VercelAIInstrumentation.PATCHED_FUNCTIONS) {
      if (typeof exports[fnName] === 'function') {
        this._wrap(exports, fnName, (original: any) => {
          const instrumentation = this;
          return function (this: any, options: any) {
            options = instrumentation._autoInjectTelemetryEnabled(options);
            return original.call(this, options);
          };
        });
        this._diag.debug(`Patched ai.${fnName}`);
      }
    }

    this._patchedExports = exports;
    return exports;
  }

  private _unpatch(): void {
    if (this._patchedExports) {
      for (const fnName of VercelAIInstrumentation.PATCHED_FUNCTIONS) {
        if (typeof this._patchedExports[fnName] === 'function') {
          this._unwrap(this._patchedExports, fnName);
        }
      }
      this._patchedExports = undefined;
    }
  }

  // Injects experimental_telemetry.isEnabled = true so that the SDK calls recordSpan with a real tracer
  // instead of the noopTracer. Also controls recordInputs and recordOutputs based on captureMessageContent.
  // see: https://github.com/vercel/ai/blob/6a06fde/packages/ai/core/telemetry/record-span.ts#L3-L41
  private _autoInjectTelemetryEnabled(options: any): any {
    if (!options || typeof options !== 'object') {
      return options;
    }

    const existing = options.experimental_telemetry;

    if (existing?.isEnabled === false) {
      return options;
    }

    const captureContent = this.getConfig().captureMessageContent ?? false;

    options.experimental_telemetry = {
      isEnabled: true,
      recordInputs: captureContent,
      recordOutputs: captureContent,
      ...existing,
    };

    return options;
  }
}
