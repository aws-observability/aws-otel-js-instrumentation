// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Data sanitization utilities for incident snapshots.
 *
 * Provides safe data minimization and sensitive field masking for
 * request payload capture in incident snapshots.
 */

/** Sensitive field patterns to detect and mask. */
export const SENSITIVE_PATTERNS: string[] = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'api_key',
  'apikey',
  'api-key',
  'token',
  'auth',
  'authorization',
  'bearer',
  'credit_card',
  'creditcard',
  'cc_number',
  'ssn',
  'social_security',
  'socialsecurity',
  'private_key',
  'privatekey',
  'priv_key',
];

export const REDACTED_VALUE = '***REDACTED***';

export interface MinimizeOptions {
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayLength?: number;
  maxDictLength?: number;
}

const DEFAULT_OPTIONS: Required<MinimizeOptions> = {
  maxDepth: 10,
  maxStringLength: 1024,
  maxArrayLength: 100,
  maxDictLength: 100,
};

/**
 * Recursively minimize objects for safe logging and storage.
 *
 * Limits object size, depth, and complexity to prevent:
 * - Memory exhaustion from large payloads
 * - Infinite recursion from circular references
 * - Excessive data capture
 *
 * @param obj - Object to minimize
 * @param opts - Minimization options
 * @param currentDepth - Current recursion depth (internal)
 * @returns Minimized object with size/depth constraints applied
 */
export function minimizeObject(obj: unknown, opts?: MinimizeOptions, currentDepth: number = 0): unknown {
  const options = { ...DEFAULT_OPTIONS, ...opts };

  // Check depth limit
  if (currentDepth >= options.maxDepth) {
    return `<max depth ${options.maxDepth} reached>`;
  }

  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle strings
  if (typeof obj === 'string') {
    if (obj.length > options.maxStringLength) {
      return obj.substring(0, options.maxStringLength) + `...[truncated, ${obj.length} chars total]`;
    }
    return obj;
  }

  // Handle Buffer
  if (Buffer.isBuffer(obj)) {
    if (obj.length > options.maxStringLength) {
      return `<bytes: ${obj.length} bytes, truncated>`;
    }
    try {
      return obj.toString('utf-8');
    } catch {
      return `<bytes: ${obj.length} bytes>`;
    }
  }

  // Handle numbers and booleans
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    if (obj.length > options.maxArrayLength) {
      const minimized = obj.slice(0, options.maxArrayLength).map(item => minimizeObject(item, opts, currentDepth + 1));
      minimized.push(`...[${obj.length - options.maxArrayLength} more items]`);
      return minimized;
    }
    return obj.map(item => minimizeObject(item, opts, currentDepth + 1));
  }

  // Handle plain objects
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length > options.maxDictLength) {
      const minimized: Record<string, unknown> = {};
      for (const [key, value] of entries.slice(0, options.maxDictLength)) {
        minimized[key] = minimizeObject(value, opts, currentDepth + 1);
      }
      minimized['__truncated__'] = `${entries.length - options.maxDictLength} more keys`;
      return minimized;
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      result[key] = minimizeObject(value, opts, currentDepth + 1);
    }
    return result;
  }

  // Handle other types - attempt string conversion
  try {
    const strRepr = String(obj);
    if (strRepr.length > options.maxStringLength) {
      return strRepr.substring(0, options.maxStringLength) + '...[truncated]';
    }
    return strRepr;
  } catch {
    return '<unknown: FAILED_TO_SERIALIZE>';
  }
}

/**
 * Remove or mask sensitive fields from dictionaries.
 *
 * Recursively scans dictionary for field names matching sensitive patterns
 * and replaces their values with "***REDACTED***".
 *
 * @param data - Dictionary to sanitize
 * @param sensitiveKeys - Additional sensitive key patterns
 * @returns Dictionary with sensitive values masked
 */
export function sanitizeSensitiveFields(
  data: Record<string, unknown>,
  sensitiveKeys?: string[]
): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return data as Record<string, unknown>;
  }

  const patterns = [...SENSITIVE_PATTERNS];
  if (sensitiveKeys) {
    patterns.push(...sensitiveKeys);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const keyLower = String(key).toLowerCase();

    // Check if key matches any sensitive pattern
    const isSensitive = patterns.some(pattern => keyLower.includes(pattern));

    if (isSensitive) {
      sanitized[key] = REDACTED_VALUE;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Recursively sanitize nested dicts
      sanitized[key] = sanitizeSensitiveFields(value as Record<string, unknown>, sensitiveKeys);
    } else if (Array.isArray(value)) {
      // Recursively sanitize lists of dicts
      sanitized[key] = value.map(item =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? sanitizeSensitiveFields(item as Record<string, unknown>, sensitiveKeys)
          : item
      );
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Truncate string to maximum length with ellipsis.
 */
export function truncateString(text: string, maxLength: number = 1024): string {
  if (text.length > maxLength) {
    return text.substring(0, maxLength) + `...[truncated, ${text.length} chars total]`;
  }
  return text;
}

/**
 * Limit array or dict size to prevent excessive data capture.
 */
export function limitCollection(collection: unknown, maxLength: number = 100): unknown {
  if (Array.isArray(collection)) {
    if (collection.length > maxLength) {
      const limited = collection.slice(0, maxLength);
      limited.push(`...[${collection.length - maxLength} more items]`);
      return limited;
    }
    return collection;
  }

  if (typeof collection === 'object' && collection !== null) {
    const entries = Object.entries(collection);
    if (entries.length > maxLength) {
      const limited: Record<string, unknown> = {};
      for (const [key, value] of entries.slice(0, maxLength)) {
        limited[key] = value;
      }
      limited['__truncated__'] = `${entries.length - maxLength} more keys`;
      return limited;
    }
    return collection;
  }

  return collection;
}
