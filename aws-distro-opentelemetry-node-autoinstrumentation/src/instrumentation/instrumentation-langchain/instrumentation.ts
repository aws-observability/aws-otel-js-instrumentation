// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from '@opentelemetry/instrumentation';
import { LIB_VERSION } from '../../version';
import { LangChainInstrumentationConfig } from './types';

const INSTRUMENTATION_NAME = '@aws/aws-distro-opentelemetry-instrumentation-langchain';

export class LangChainInstrumentation extends InstrumentationBase<LangChainInstrumentationConfig> {
  constructor(config: LangChainInstrumentationConfig = {}) {
    super(INSTRUMENTATION_NAME, LIB_VERSION, config);
  }

  override setConfig(config: LangChainInstrumentationConfig = {}) {
    super.setConfig({ ...config, captureMessageContent: !!config.captureMessageContent });
  }

  protected init() {
    const callbackManagerFile = new InstrumentationNodeModuleFile(
      '@langchain/core/dist/callbacks/manager.cjs',
      ['>=0.3.58'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (modExports: any) => {
        this._diag.debug('Applying LangChain instrumentation to CallbackManager');
        this._patchCallbackManager(modExports?.CallbackManager);
        return modExports;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (modExports: any) => {
        this._diag.debug('Removing LangChain instrumentation from CallbackManager');
        this._unpatchCallbackManager(modExports?.CallbackManager);
        return modExports;
      }
    );

    return [
      new InstrumentationNodeModuleDefinition(
        '@langchain/core',
        ['>=0.3.58'],
        (modExports: unknown) => modExports,
        () => {},
        [callbackManagerFile]
      ),
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _patchCallbackManager(CallbackManager: any): void {
    if (!CallbackManager || CallbackManager._otelPatched) return;

    const methodName = '_configureSync' in CallbackManager ? '_configureSync' : 'configure';
    const original = CallbackManager[methodName];
    if (typeof original !== 'function') return;

    const diag = this._diag;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OpenTelemetryCallbackHandler } = require('./callback-handler');
    const handler = new OpenTelemetryCallbackHandler(this.tracer, !!this.getConfig().captureMessageContent);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CallbackManager[methodName] = function (...args: any[]) {
      args[0] = LangChainInstrumentation._injectHandler(args[0], handler);
      diag.debug('Injected OTel callback handler into LangChain CallbackManager');
      return original.apply(this, args);
    };

    CallbackManager._otelPatched = true;
    CallbackManager._otelOriginal = original;
    CallbackManager._otelMethodName = methodName;

    this._diag.debug(`Patched CallbackManager.${methodName}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _unpatchCallbackManager(CallbackManager: any): void {
    if (!CallbackManager?._otelPatched) return;

    const methodName = CallbackManager._otelMethodName;
    CallbackManager[methodName] = CallbackManager._otelOriginal;
    delete CallbackManager._otelPatched;
    delete CallbackManager._otelOriginal;
    delete CallbackManager._otelMethodName;
    this._diag.debug(`Unpatched CallbackManager.${methodName}`);
  }

  private static _injectHandler(handlers: unknown, handler: unknown): unknown {
    if (Array.isArray(handlers)) {
      if (!handlers.includes(handler)) {
        handlers.push(handler);
      }
      return handlers;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const manager = handlers as any;
    if (manager && typeof manager === 'object' && typeof manager.addHandler === 'function') {
      if (!manager.handlers?.includes(handler)) {
        manager.addHandler(handler, true);
      }
      return manager;
    }

    return [handler];
  }

  override _updateMetricInstruments() {}
}
