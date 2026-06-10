// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Data sanitization utilities for incident snapshots.
 *
 * Currently just length truncation: incident exception messages and stack traces
 * are on the default-on path (any 5xx / unhandled error produces them) and can carry
 * PII / large payloads, so they are truncated before emission. Request-payload capture
 * (and the object-minimization / sensitive-field-redaction helpers it once used) was
 * removed, so only truncateString remains.
 */

/**
 * Truncate string to maximum length with ellipsis.
 */
export function truncateString(text: string, maxLength: number = 1024): string {
  if (text.length > maxLength) {
    return text.substring(0, maxLength) + `...[truncated, ${text.length} chars total]`;
  }
  return text;
}
