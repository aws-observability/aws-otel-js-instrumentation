// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';

// The two NodeSDK internal layouts for span-processor assembly, detected at runtime:
//   - FIELD  (sdk-node <= 0.219): the constructor assembles a `_tracerProviderConfig` instance field.
//   - CONFIG (sdk-node >= 0.220): start() derives spanProcessors as a local from `this._configuration`.
// UNKNOWN means neither was recognized on a probe instance -> the caller disables the patch.
export type SdkShape = 'FIELD' | 'CONFIG' | 'UNKNOWN';

// Construct a throwaway NodeSDK and inspect which internal field it uses to hold span-processor
// config. Detecting the layout (rather than matching a version number) self-adapts to new sdk-node
// releases that keep a known shape, and fails safe on ones that don't. Any error, or neither field
// being present, is UNKNOWN.
export function detectShape(NodeSDK: new (config: Record<string, unknown>) => unknown, version: string): SdkShape {
  try {
    const probe = new NodeSDK({ spanProcessors: [] }) as Record<string, unknown>;
    if (probe._tracerProviderConfig !== undefined) {
      return 'FIELD';
    }
    if (probe._configuration !== undefined) {
      return 'CONFIG';
    }
    diag.warn(`[span-metrics] sdk-node ${version}: no known span-processor field on NodeSDK instance`);
    return 'UNKNOWN';
  } catch (e) {
    diag.warn(`[span-metrics] sdk-node ${version}: shape probe threw`, e);
    return 'UNKNOWN';
  }
}
