// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Registry of application-defined baggage scopes for ScopedBaggageSpanProcessor. This module has no SDK
// dependencies, so the register entry point can export registerBaggageScope() in Lambda fast-start mode
// without loading the full SDK.

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

export type ScopePredicate = (span: ReadableSpan) => boolean;

// Built-in scope names. Application scopes cannot replace them. Kept here, without the predicates, so
// this module does not load the processor.
export const BUILTIN_SCOPE_NAMES: ReadonlySet<string> = new Set(['inference']);

// Kept on a global symbol so every copy of this package in the process shares one registry.
const REGISTRY_KEY = Symbol.for('aws.adot.baggageScopes');
const globalRegistry = globalThis as unknown as Record<symbol, Map<string, ScopePredicate> | undefined>;

/** The application-registered scope with this name, if any. */
export function getRegisteredBaggageScope(name: string): ScopePredicate | undefined {
  return globalRegistry[REGISTRY_KEY]?.get(name);
}

/** Remove all application-registered scopes. For tests. */
export function clearRegisteredBaggageScopes(): void {
  globalRegistry[REGISTRY_KEY] = undefined;
}

function warn(message: string): void {
  // Load the API only on this path, so fast-start mode does not pay for it at startup.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { diag } = require('@opentelemetry/api');
  diag.warn(message);
}

/**
 * Define a baggage scope for use in OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS. Not part of the documented API.
 *
 * After registration, `OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS=my.key:<name>` copies baggage entry `my.key` only
 * to spans for which `predicate` returns true. The predicate receives the ending span. It runs
 * synchronously at the end of every span that carries such a key, so it must be fast and must not modify
 * the span. If it throws, the key is not copied to that span.
 *
 * Scope names are looked up when each span ends, so the scope can be registered at application startup,
 * after the distro has read the environment variable. Registering an existing custom name replaces it.
 * Scoped keys are not supported in Lambda fast-start mode.
 *
 * @returns false, without registering, when the name is empty, has surrounding whitespace, contains `:`
 * or `,`, or is a built-in scope such as `inference`, or when `predicate` is not a function.
 */
export function registerBaggageScope(name: string, predicate: ScopePredicate): boolean {
  if (typeof name !== 'string' || name === '' || name !== name.trim() || /[:,]/.test(name)) {
    warn(`Invalid baggage scope name '${name}'.`);
    return false;
  }
  if (BUILTIN_SCOPE_NAMES.has(name)) {
    warn(`Baggage scope '${name}' is built in and cannot be replaced.`);
    return false;
  }
  if (typeof predicate !== 'function') {
    warn(`Baggage scope '${name}' needs a predicate function.`);
    return false;
  }
  // Replace the map so a registration never changes it while a span is being processed.
  const scopes = new Map(globalRegistry[REGISTRY_KEY] ?? []);
  scopes.set(name, predicate);
  globalRegistry[REGISTRY_KEY] = scopes;
  return true;
}
