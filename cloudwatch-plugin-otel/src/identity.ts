// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LIB_VERSION } from './version';

// Identity/dedup markers (spec §6), stamped on both spans and generated metrics.
export const SCHEMA_ATTR = 'aws.otel.span.metrics.schema';
export const LIB_VERSION_ATTR = 'aws.otel.extension.lib.version';

// Presence of SCHEMA_ATTR on a span is the dedup signal: the backend skips regenerating metrics
// for any span already carrying it. Bump when the metric shape changes.
export const SCHEMA_VERSION = 'v1';

// The library version (debug-only marker; consumers must not key logic on it). Generated from
// package.json at build time into version.ts, so it stays a compile-time constant with no runtime
// filesystem read and works regardless of bundling.
export { LIB_VERSION };
