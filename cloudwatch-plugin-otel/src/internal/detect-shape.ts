// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';

// The two NodeSDK internal layouts for span-processor assembly, detected at runtime:
//   - FIELD  (sdk-node <= 0.219): the constructor assembles a `_tracerProviderConfig` instance field.
//   - CONFIG (sdk-node >= 0.220): start() derives spanProcessors as a local from `this._configuration`.
// UNKNOWN means neither was recognized on a probe instance -> the caller disables the patch.
export type SdkShape = 'FIELD' | 'CONFIG' | 'UNKNOWN';

// Detect which internal layout a NodeSDK class uses by inspecting its constructor SOURCE, without
// instantiating it. Constructing a real NodeSDK just to sniff a field has live side effects (it reads
// env and can bind exporters/readers — e.g. OTEL_METRICS_EXPORTER=prometheus opens port 9464), so we
// never do that here. Detecting the layout (rather than matching a version number) self-adapts to new
// sdk-node releases that keep a known shape and fails safe on ones that don't.
//
// The disambiguating signal is the private class-field declaration `_tracerProviderConfig`, which the
// FIELD era (<= 0.219) declares and the CONFIG era (>= 0.220) removed. Both eras declare
// `_configuration`, so its presence alone cannot distinguish them — `_tracerProviderConfig` must be
// checked first. This mirrors the exact field names the register patch relies on at runtime, so the
// coupling is no tighter than the injection code itself; it just avoids the side effect.
export function detectShape(NodeSDK: new (config: Record<string, unknown>) => unknown, version: string): SdkShape {
  try {
    const source = NodeSDK.toString();
    if (source.includes('_tracerProviderConfig')) {
      return 'FIELD';
    }
    if (source.includes('_configuration')) {
      return 'CONFIG';
    }
    diag.warn(`[span-metrics] sdk-node ${version}: no known span-processor field in NodeSDK source`);
    return 'UNKNOWN';
  } catch (e) {
    diag.warn(`[span-metrics] sdk-node ${version}: shape probe threw`, e);
    return 'UNKNOWN';
  }
}
