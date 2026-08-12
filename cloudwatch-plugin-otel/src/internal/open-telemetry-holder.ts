// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { MeterProvider, diag } from '@opentelemetry/api';

// Bridges the host's fully-built MeterProvider to the span processor. The processor is constructed
// before the MeterProvider exists, so the provider is supplied later by whichever host hook fires:
// the register patch, withSpanMetrics(), or a manual bind() call. Internal, not public API.

let instance: MeterProvider | undefined;

// First bind wins. A later bind of a different provider is ignored but logged.
export function set(meterProvider: MeterProvider): void {
  if (instance === undefined) {
    instance = meterProvider;
  } else if (instance !== meterProvider) {
    diag.warn(
      'Span metrics already bound to a MeterProvider; ignoring a later, different bind. ' +
        'Span metrics will use the first provider.'
    );
  }
}

export function get(): MeterProvider | undefined {
  return instance;
}

// Test-only reset so suites can rebind a fresh provider.
export function resetForTest(): void {
  instance = undefined;
}
