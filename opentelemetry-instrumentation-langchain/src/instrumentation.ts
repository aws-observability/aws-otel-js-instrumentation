// SPDX-License-Identifier: Apache-2.0

/**
 * LangChain instrumentation for OpenTelemetry.
 *
 * This module provides an InstrumentationBase subclass that patches
 * @langchain/core's CallbackManager to automatically inject the OTel
 * callback handler into all LangChain operations.
 */

import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from '@opentelemetry/instrumentation';
import { VERSION } from './version';
import { OTelCallbackHandler } from './callback-handler';

/**
 * LangChain instrumentation for OpenTelemetry.
 *
 * Patches CallbackManager._configureSync to inject the OTel callback handler
 * into all LangChain operations. This enables automatic tracing without
 * user code changes.
 */
export class LangChainInstrumentation extends InstrumentationBase {
  constructor() {
    super('opentelemetry-instrumentation-langchain', VERSION, {});
  }

  /**
   * Initializes the instrumentation by returning module definitions.
   */
  protected init(): InstrumentationNodeModuleDefinition[] {
    return [
      new InstrumentationNodeModuleDefinition(
        '@langchain/core',
        ['>=0.3.0'],
        undefined,
        undefined,
        [
          new InstrumentationNodeModuleFile(
            '@langchain/core/dist/callbacks/manager.cjs',
            ['>=0.3.0'],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (moduleExports: any, moduleVersion?: string) => {
              this._diag.debug(`Patching @langchain/core/dist/callbacks/manager.cjs@${moduleVersion}`);
              if (moduleExports?.CallbackManager) {
                this._patchCallbackManager(moduleExports.CallbackManager);
              }
              return moduleExports;
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (moduleExports: any) => {
              this._diag.debug('Unpatching @langchain/core/dist/callbacks/manager.cjs');
              if (moduleExports?.CallbackManager) {
                this._unpatchCallbackManager(moduleExports.CallbackManager);
              }
              return moduleExports;
            }
          ),
        ]
      ),
    ];
  }

  /**
   * Patches CallbackManager._configureSync to inject our handler.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _patchCallbackManager(CallbackManager: any): void {
    if (CallbackManager._configureSync && !CallbackManager._otelPatched) {
      const originalConfigureSync = CallbackManager._configureSync;
      const tracer = this.tracer;
      const diag = this._diag;

      CallbackManager._configureSync = function (
        inheritableHandlers: unknown[] | undefined,
        localHandlers: unknown[] | undefined,
        inheritableTags: unknown,
        localTags: unknown,
        inheritableMetadata: unknown,
        localMetadata: unknown
      ) {
        diag.debug('_configureSync called, injecting OTelCallbackHandler');
        const handler = new OTelCallbackHandler(tracer);
        const updatedHandlers = Array.isArray(inheritableHandlers)
          ? [...inheritableHandlers, handler]
          : [handler];

        return originalConfigureSync.call(
          this,
          updatedHandlers,
          localHandlers,
          inheritableTags,
          localTags,
          inheritableMetadata,
          localMetadata
        );
      };

      CallbackManager._otelPatched = true;
      CallbackManager._otelOriginalConfigureSync = originalConfigureSync;
      this._diag.debug('Patched CallbackManager._configureSync');
    }
  }

  /**
   * Restores original CallbackManager._configureSync.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _unpatchCallbackManager(CallbackManager: any): void {
    if (CallbackManager._otelPatched && CallbackManager._otelOriginalConfigureSync) {
      CallbackManager._configureSync = CallbackManager._otelOriginalConfigureSync;
      delete CallbackManager._otelPatched;
      delete CallbackManager._otelOriginalConfigureSync;
      this._diag.debug('Unpatched CallbackManager._configureSync');
    }
  }
}
