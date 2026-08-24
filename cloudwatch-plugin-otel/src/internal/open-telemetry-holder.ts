// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { MeterProvider, createNoopMeter, metrics, diag } from '@opentelemetry/api';

// Bridges the host's MeterProvider to the span processor. The processor is constructed before any
// MeterProvider exists, so a usable provider is resolved lazily at record time from one of two
// sources, in order:
//   1. An explicitly bound provider (manual bind(), or a host that owns a non-global provider).
//   2. The global MeterProvider (api.metrics.getMeterProvider()) — NodeSDK registers the provider it
//      builds as the global one, so programmatic/zero-code users need no explicit bind: the SDK-owned
//      provider (carrying the app's resource) is picked up automatically once start() has run.
// A provider is only "usable" once it is non-noop; before the SDK starts, the global provider is the
// API's NoopMeterProvider, which we must reject so we don't cache noop instruments or mark spans we
// cannot meter. Internal, not public API.

let instance: MeterProvider | undefined;

// Constructor of the instruments the API's noop meter produces. Used to recognize a noop provider
// through public API (there is no exported noop-provider class or isNoop helper): a provider is noop
// if a meter it hands out yields instruments of this class.
const NOOP_INSTRUMENT_CTOR = createNoopMeter().createCounter('probe').constructor;

// Explicit bind. First bind wins; a later, different bind is ignored but logged.
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

// A provider is usable only if it is non-noop (i.e. can actually produce recording instruments).
function isUsable(provider: MeterProvider | undefined): provider is MeterProvider {
  if (provider === undefined) {
    return false;
  }
  try {
    const probe = provider.getMeter('cloudwatch.plugin.otel.probe').createCounter('probe');
    return probe.constructor !== NOOP_INSTRUMENT_CTOR;
  } catch {
    return false;
  }
}

// The usable MeterProvider to record into: the explicitly bound one if set, else the global provider
// once it is non-noop. Returns undefined when neither is usable yet (e.g. before SDK start, or with
// metrics disabled) — callers must treat that as "cannot meter" and not mark spans.
export function get(): MeterProvider | undefined {
  if (instance !== undefined) {
    return instance;
  }
  const global = metrics.getMeterProvider();
  return isUsable(global) ? global : undefined;
}

// True when a usable MeterProvider is available. Callers must not stamp the dedup marker on a span
// before this is true, or the backend would skip a span the extension never metered.
export function hasProvider(): boolean {
  return get() !== undefined;
}

// Test-only reset so suites can rebind a fresh provider.
export function resetForTest(): void {
  instance = undefined;
}
