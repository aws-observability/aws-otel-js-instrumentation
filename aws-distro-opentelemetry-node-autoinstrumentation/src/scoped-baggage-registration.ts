// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Registration hook for ScopedBaggageSpanProcessor. This module has no SDK dependencies, so the
// register entry point can export the hook in Lambda fast-start mode without loading the full SDK.

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

export type ScopedBaggagePredicate = (span: ReadableSpan) => boolean;

interface ScopedBaggageRegistrar {
  register(key: string, scope: string | ScopedBaggagePredicate): boolean;
}

// Kept on a global symbol so every copy of this package in the process shares one active processor.
const ACTIVE_PROCESSOR_KEY = Symbol.for('aws.adot.scopedBaggageSpanProcessor');
const globalRegistry = globalThis as unknown as Record<symbol, ScopedBaggageRegistrar | undefined>;

/**
 * Makes `processor` the target of registerScopedBaggageKey() unless another processor already is. The
 * first copy of the distro to start owns the global tracer provider, so its processor is the one that
 * sees spans. Returns true when `processor` became active.
 */
export function claimActiveScopedBaggageSpanProcessor(processor: ScopedBaggageRegistrar): boolean {
  if (globalRegistry[ACTIVE_PROCESSOR_KEY]) {
    return false;
  }
  globalRegistry[ACTIVE_PROCESSOR_KEY] = processor;
  return true;
}

/** Clears the active processor if it is `processor`, for example when it shuts down. */
export function releaseActiveScopedBaggageSpanProcessor(processor: ScopedBaggageRegistrar): void {
  if (globalRegistry[ACTIVE_PROCESSOR_KEY] === processor) {
    globalRegistry[ACTIVE_PROCESSOR_KEY] = undefined;
  }
}

/** Sets or clears the active processor unconditionally. For tests. */
export function setActiveScopedBaggageSpanProcessor(processor: ScopedBaggageRegistrar | undefined): void {
  globalRegistry[ACTIVE_PROCESSOR_KEY] = processor;
}

/**
 * Copy baggage entry `key` to spans that match `scope`. Not part of the documented API.
 *
 * Call it from application code after the distro has started. `scope` is a built-in scope name (for
 * example `'inference'`) or a predicate that receives the ending span and returns true to copy the key.
 * A predicate runs synchronously at the end of every span that carries the key, so it must be fast and
 * must not modify the span. If it throws, the key is not copied to that span.
 *
 * A key that is also listed in OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS is already copied to every span at start,
 * and that value is kept.
 *
 * @returns false, without registering, when no scoped baggage processor is installed or the scope is
 * unknown. The processor is installed only when AGENT_OBSERVABILITY_ENABLED=true, and not in Lambda
 * fast-start mode.
 */
export function registerScopedBaggageKey(key: string, scope: string | ScopedBaggagePredicate): boolean {
  const processor = globalRegistry[ACTIVE_PROCESSOR_KEY];
  if (!processor) {
    // Load the API only on this path, so fast-start mode does not pay for it at startup.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { diag } = require('@opentelemetry/api');
    diag.warn(
      `Cannot register scoped baggage key '${key}': no scoped baggage processor is installed. It requires ` +
        'AGENT_OBSERVABILITY_ENABLED=true and is not available in Lambda fast-start mode.'
    );
    return false;
  }
  return processor.register(key, scope);
}
