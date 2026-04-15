// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-this-alias */

import { context } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from '@opentelemetry/instrumentation';
import { LIB_VERSION } from '../../version';
import { LangChainInstrumentationConfig } from './types';

const INSTRUMENTATION_NAME = '@aws/aws-distro-opentelemetry-instrumentation-langchain';
const SUPPORTED_VERSIONS = ['>=1.0.0'];

export class LangChainInstrumentation extends InstrumentationBase<LangChainInstrumentationConfig> {
  // Track patched objects by identity to avoid double-patching across CJS/ESM.
  // See: https://github.com/open-telemetry/opentelemetry-js/issues/6489
  _patchedCallbackManager: any = undefined;
  _patchedCallbackManagerMethod: string = '';
  _patchedChatModelsProto: any = undefined;
  _patchedToolsProto: any = undefined;
  _handler: any = undefined;

  _wrappedChatProtos: Set<any> = new Set();
  _wrappedToolProtos: Set<any> = new Set();

  constructor(config: LangChainInstrumentationConfig = {}) {
    super(INSTRUMENTATION_NAME, LIB_VERSION, config);
  }

  override setConfig(config: LangChainInstrumentationConfig = {}) {
    super.setConfig({ ...config, captureMessageContent: !!config.captureMessageContent });
  }

  protected init() {
    const moduleFiles = (path: string, patch: (m: any) => any, unpatch: (m: any) => any) => [
      new InstrumentationNodeModuleFile(`${path}.cjs`, SUPPORTED_VERSIONS, patch, unpatch),
      new InstrumentationNodeModuleFile(`${path}.js`, SUPPORTED_VERSIONS, patch, unpatch),
    ];

    return [
      new InstrumentationNodeModuleDefinition(
        '@langchain/core',
        SUPPORTED_VERSIONS,
        (m: unknown) => m,
        () => {},
        [
          ...moduleFiles(
            '@langchain/core/dist/callbacks/manager',
            (m: any) => {
              this._patchCallbackManager(m?.CallbackManager);
              return m;
            },
            (m: any) => {
              this._unpatchCallbackManager(m?.CallbackManager);
              return m;
            }
          ),
          ...moduleFiles(
            '@langchain/core/dist/language_models/chat_models',
            (m: any) => this._patchChatModelsModule(m),
            (m: any) => this._unpatchChatModelsModule(m)
          ),
          ...moduleFiles(
            '@langchain/core/dist/tools/index',
            (m: any) => this._patchToolsModule(m),
            (m: any) => this._unpatchToolsModule(m)
          ),
        ]
      ),
    ];
  }

  _patchCallbackManager(CallbackManager: any): void {
    if (!CallbackManager || this._patchedCallbackManager === CallbackManager) return;

    const methodName = '_configureSync' in CallbackManager ? '_configureSync' : 'configure';
    if (typeof CallbackManager[methodName] !== 'function') return;

    const langChainInstrumentation = this;

    this._wrap(CallbackManager, methodName, (original: any) => {
      return function (this: any, ...args: any[]) {
        if (!langChainInstrumentation._handler) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { OpenTelemetryCallbackHandler } = require('./callback-handler');
          langChainInstrumentation._handler = new OpenTelemetryCallbackHandler(
            langChainInstrumentation.tracer,
            !!langChainInstrumentation.getConfig().captureMessageContent
          );
          langChainInstrumentation._diag.debug('Lazily loaded OTel callback handler');
        }
        args[0] = LangChainInstrumentation._injectHandler(args[0], langChainInstrumentation._handler);
        return original.apply(this, args);
      };
    });

    this._patchedCallbackManager = CallbackManager;
    this._patchedCallbackManagerMethod = methodName;
    this._diag.debug(`Patched CallbackManager.${methodName}`);
  }

  _unpatchCallbackManager(CallbackManager: any): void {
    if (!CallbackManager || this._patchedCallbackManager !== CallbackManager) return;

    this._unwrap(CallbackManager, this._patchedCallbackManagerMethod);
    this._patchedCallbackManager = undefined;
    this._patchedCallbackManagerMethod = '';
    this._handler = undefined;
    this._diag.debug('Unpatched CallbackManager');
  }

  _patchChatModelsModule(modExports: any): any {
    const proto = modExports?.BaseChatModel?.prototype;
    if (!proto || this._patchedChatModelsProto === proto) return modExports;

    const langChainInstrumentation = this;
    this._wrap(proto, '_generateUncached', (original: any) => {
      return function (this: any, ...args: any[]) {
        langChainInstrumentation._propagateContextOnChatProto(Object.getPrototypeOf(this));
        return original.apply(this, args);
      };
    });

    this._patchedChatModelsProto = proto;
    this._diag.debug('Patched BaseChatModel.prototype._generateUncached');
    return modExports;
  }

  _unpatchChatModelsModule(modExports: any): any {
    const proto = modExports?.BaseChatModel?.prototype;
    if (!proto || this._patchedChatModelsProto !== proto) return modExports;

    this._unwrap(proto, '_generateUncached');
    for (const p of this._wrappedChatProtos) {
      if (typeof p._generate === 'function') this._unwrap(p, '_generate');
      if (typeof p._streamResponseChunks === 'function') this._unwrap(p, '_streamResponseChunks');
    }
    this._wrappedChatProtos.clear();
    this._patchedChatModelsProto = undefined;
    this._diag.debug('Unpatched BaseChatModel and all concrete chat model prototypes');
    return modExports;
  }

  _patchToolsModule(modExports: any): any {
    const proto = modExports?.StructuredTool?.prototype;
    if (!proto || this._patchedToolsProto === proto) return modExports;

    const langChainInstrumentation = this;
    this._wrap(proto, 'call', (original: any) => {
      return function (this: any, ...args: any[]) {
        langChainInstrumentation._propagateContextOnToolProto(Object.getPrototypeOf(this));
        return original.apply(this, args);
      };
    });

    this._patchedToolsProto = proto;
    this._diag.debug('Patched StructuredTool.prototype.call');
    return modExports;
  }

  _unpatchToolsModule(modExports: any): any {
    const proto = modExports?.StructuredTool?.prototype;
    if (!proto || this._patchedToolsProto !== proto) return modExports;

    this._unwrap(proto, 'call');
    for (const p of this._wrappedToolProtos) {
      if (typeof p._call === 'function') this._unwrap(p, '_call');
    }
    this._wrappedToolProtos.clear();
    this._patchedToolsProto = undefined;
    this._diag.debug('Unpatched StructuredTool and all concrete tool prototypes');
    return modExports;
  }

  override _updateMetricInstruments() {}

  private _propagateContextOnChatProto(concreteProto: any): void {
    if (!concreteProto || this._wrappedChatProtos.has(concreteProto)) return;
    this._wrappedChatProtos.add(concreteProto);
    const langChainInstrumentation = this;

    if (typeof concreteProto._generate === 'function') {
      this._wrap(concreteProto, '_generate', (original: any) => {
        return function (this: any, ...genArgs: any[]) {
          const spanCtx = langChainInstrumentation._handler?.runIdToSpanMap?.get(genArgs[2]?.runId)?.context;
          if (spanCtx) return context.with(spanCtx, () => original.apply(this, genArgs));
          return original.apply(this, genArgs);
        };
      });
    }

    if (typeof concreteProto._streamResponseChunks === 'function') {
      this._wrap(concreteProto, '_streamResponseChunks', (original: any) => {
        return function (this: any, ...streamArgs: any[]) {
          const spanCtx = langChainInstrumentation._handler?.runIdToSpanMap?.get(streamArgs[2]?.runId)?.context;
          if (!spanCtx) return original.apply(this, streamArgs);
          const gen = context.with(spanCtx, () => original.apply(this, streamArgs));
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            next() {
              return context.with(spanCtx, () => gen.next());
            },
            return(value: any) {
              return context.with(spanCtx, () => gen.return(value));
            },
            throw(err: any) {
              return context.with(spanCtx, () => gen.throw(err));
            },
          };
        };
      });
    }

    this._diag.debug(`Wrapped context propagation on ${concreteProto.constructor?.name || 'unknown'} prototype`);
  }

  private _propagateContextOnToolProto(concreteProto: any): void {
    if (!concreteProto || this._wrappedToolProtos.has(concreteProto)) return;
    this._wrappedToolProtos.add(concreteProto);
    const langChainInstrumentation = this;

    if (typeof concreteProto._call === 'function') {
      this._wrap(concreteProto, '_call', (original: any) => {
        return function (this: any, ...callArgs: any[]) {
          const spanCtx = langChainInstrumentation._handler?.runIdToSpanMap?.get(callArgs[1]?.runId)?.context;
          if (spanCtx) return context.with(spanCtx, () => original.apply(this, callArgs));
          return original.apply(this, callArgs);
        };
      });
    }

    this._diag.debug(`Wrapped context propagation on ${concreteProto.constructor?.name || 'unknown'} tool prototype`);
  }

  private static _injectHandler(handlers: unknown, handler: unknown): unknown {
    if (Array.isArray(handlers)) {
      if (!handlers.includes(handler)) {
        handlers.push(handler);
      }
      return handlers;
    }

    const manager = handlers as any;
    if (manager && typeof manager === 'object' && typeof manager.addHandler === 'function') {
      if (!manager.handlers?.includes(handler)) {
        manager.addHandler(handler, true);
      }
      return manager;
    }

    return [handler];
  }
}
