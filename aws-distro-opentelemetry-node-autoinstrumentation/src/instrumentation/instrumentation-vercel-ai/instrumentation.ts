// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { types } from 'util';
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { LIB_VERSION } from '../../version';
import { VercelAIInstrumentationConfig } from './types';
import { VercelAISpanProcessor } from './span-processor';

export const INSTRUMENTATION_NAME = '@aws/aws-distro-opentelemetry-instrumentation-vercel-ai';
export const INSTRUMENTATION_SHORT_NAME = 'aws_vercel_ai';

const SUPPORTED_VERSIONS = ['>=3.3.0 <7.0.0'];

export class VercelAIInstrumentation extends InstrumentationBase<VercelAIInstrumentationConfig> {
  // Vercel AI SDK provides native OTel integration but uses its own
  // semantic conventions rather than the standard OTel GenAI conventions.
  // See: https://ai-sdk.dev/docs/ai-sdk-core/telemetry#semantic-conventions
  //
  // This instrumentation does two things:
  //
  // - Patches their code always enable telemetry generation. By default the Vercel AI SDK has
  //    telemetry disabled and requires users to explicitly opt in by setting
  //    experimental_telemetry.isEnabled = true on every call.
  // - Registers a VercelAISpanProcessor that translates the VerceL span attributes into OTel semantic conventions.
  private static readonly FUNCTIONS_TO_PATCH: string[] = [
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
        (moduleExports: any) => this._alwaysEnableTelemetryWrapper(moduleExports),
        (_moduleExports: any) => this._alwaysEnableTelemetryUnwrap()
      ),
    ];
  }

  private _alwaysEnableTelemetryWrapper(moduleExports: any): any {
    // The exports we are trying to patch in CJS have non-configurable properties,
    // so we must copy them into a plain object. However in ESM exports are wrappable directly.
    const isESM = types.isProxy(moduleExports);
    const exports = isESM ? moduleExports : { ...moduleExports };

    for (const fnName of VercelAIInstrumentation.FUNCTIONS_TO_PATCH) {
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

  private _alwaysEnableTelemetryUnwrap(): void {
    if (this._patchedExports) {
      for (const fnName of VercelAIInstrumentation.FUNCTIONS_TO_PATCH) {
        if (typeof this._patchedExports[fnName] === 'function') {
          this._unwrap(this._patchedExports, fnName);
        }
      }
      this._patchedExports = undefined;
    }
  }

  // automatically enables SDK telemetry to always be on
  // see: https://github.com/vercel/ai/blob/6a06fde/packages/ai/core/telemetry/get-tracer.ts#L4-L13
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
