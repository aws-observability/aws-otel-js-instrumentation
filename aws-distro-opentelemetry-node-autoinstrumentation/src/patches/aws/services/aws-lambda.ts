// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import { AwsLambdaInstrumentation } from '@opentelemetry/instrumentation-aws-lambda';
import * as path from 'path';
import * as fs from 'fs';
import {
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
} from '@opentelemetry/instrumentation';
import { diag } from '@opentelemetry/api';

export class AwsLambdaInstrumentationPatch extends AwsLambdaInstrumentation {
  override init() {
    // Custom logic before calling the original implementation
    diag.debug('Initializing AwsLambdaInstrumentationPatch');
    const taskRoot = process.env.LAMBDA_TASK_ROOT;
    const handlerDef = this._config.lambdaHandler ?? process.env._HANDLER;

    // _HANDLER and LAMBDA_TASK_ROOT are always defined in Lambda but guard bail out if in the future this changes.
    if (!taskRoot || !handlerDef) {
      this._diag.debug('Skipping lambda instrumentation: no _HANDLER/lambdaHandler or LAMBDA_TASK_ROOT.', {
        taskRoot,
        handlerDef,
      });
      return [];
    }

    const handler = path.basename(handlerDef);
    const moduleRoot = handlerDef.substr(0, handlerDef.length - handler.length);

    const [module, functionName] = handler.split('.', 2);

    // Lambda loads user function using an absolute path.
    let filename = path.resolve(taskRoot, moduleRoot, module);
    if (!filename.endsWith('.js')) {
      // its impossible to know in advance if the user has a cjs or js or mjs file.
      // check that the .js file exists otherwise fallback to next known possibility
      try {
        fs.statSync(`${filename}.js`);
        filename += '.js';
      } catch (e) {
        // fallback to .cjs
        try {
          fs.statSync(`${filename}.cjs`);
          filename += '.cjs';
        } catch (e) {
          // fall back to .mjs
          filename += '.mjs';
        }
      }
    }

    diag.debug('Instrumenting lambda handler', {
      taskRoot,
      handlerDef,
      handler,
      moduleRoot,
      module,
      filename,
      functionName,
    });

    if (filename.endsWith('.mjs') || process.env.HANDLER_IS_ESM) {
      return [
        new InstrumentationNodeModuleDefinition(
          // NB: The patching infrastructure seems to match names backwards, this must be the filename, while
          // InstrumentationNodeModuleFile must be the module name.
          filename,
          ['*'],
          (moduleExports: any) => {
            diag.debug('Applying patch for lambda esm handler');
            if (isWrapped(moduleExports[functionName])) {
              this._unwrap(moduleExports, functionName);
            }
            this._wrap(moduleExports, functionName, (this as any)._getHandler());
            return moduleExports;
          },
          (moduleExports?: any) => {
            if (moduleExports == null) return;
            diag.debug('Removing patch for lambda esm handler');
            this._unwrap(moduleExports, functionName);
          }
        ),
      ];
    } else {
      return [
        new InstrumentationNodeModuleDefinition(
          // NB: The patching infrastructure seems to match names backwards, this must be the filename, while
          // InstrumentationNodeModuleFile must be the module name.
          filename,
          ['*'],
          undefined,
          undefined,
          [
            new InstrumentationNodeModuleFile(
              module,
              ['*'],
              (moduleExports: any) => {
                diag.debug('Applying patch for lambda handler');
                if (isWrapped(moduleExports[functionName])) {
                  this._unwrap(moduleExports, functionName);
                }
                this._wrap(moduleExports, functionName, (this as any)._getHandler());
                return moduleExports;
              },
              (moduleExports?: any) => {
                if (moduleExports == null) return;
                diag.debug('Removing patch for lambda handler');
                this._unwrap(moduleExports, functionName);
              }
            ),
          ]
        ),
      ];
    }
  }
}
