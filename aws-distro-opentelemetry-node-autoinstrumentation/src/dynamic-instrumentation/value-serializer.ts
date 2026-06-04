// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CapturedValue } from './model/snapshot';
import { CaptureConfiguration, CAPTURE_DEFAULTS } from './model/capture-configuration';

const SERIALIZATION_TIMEOUT_MS = 200;

/**
 * Serialize a JavaScript value into a CapturedValue tree.
 *
 * Respects depth, width, string length, and field count limits.
 * Handles: primitives, arrays, objects, Maps, Sets, Dates, Errors, Buffers,
 * RegExps, null, undefined. Circular references detected and reported.
 *
 * Uses a deadline-based timeout to prevent runaway serialization.
 */
export function serializeValue(
  value: unknown,
  limits: CaptureConfiguration = CAPTURE_DEFAULTS as CaptureConfiguration,
  deadline?: number,
  currentDepth: number = 0,
  visited: Set<object> = new Set()
): CapturedValue {
  const effectiveDeadline = deadline ?? Date.now() + SERIALIZATION_TIMEOUT_MS;

  // Timeout check
  if (Date.now() > effectiveDeadline) {
    return { type: typeOf(value), notCapturedReason: 'timeout' };
  }

  // Depth check
  if (currentDepth > limits.maxObjectDepth) {
    return { type: typeOf(value), notCapturedReason: 'depth' };
  }

  // null
  if (value === null) {
    return { type: 'null', isNull: true };
  }

  // undefined
  if (value === undefined) {
    return { type: 'undefined', value: 'undefined' };
  }

  // Primitives
  if (typeof value === 'string') {
    return serializeString(value, limits.maxStringLength);
  }
  if (typeof value === 'number') {
    return { type: 'number', value: String(value) };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean', value: String(value) };
  }
  if (typeof value === 'bigint') {
    return { type: 'bigint', value: String(value) };
  }
  if (typeof value === 'symbol') {
    return { type: 'symbol', value: value.toString() };
  }
  if (typeof value === 'function') {
    return { type: 'function', value: value.name || '(anonymous)' };
  }

  // Objects — check for circular references
  const obj = value as object;
  if (visited.has(obj)) {
    return { type: typeOf(obj), notCapturedReason: 'circular' };
  }
  visited.add(obj);

  try {
    // Date
    if (value instanceof Date) {
      return { type: 'Date', value: value.toISOString() };
    }

    // RegExp
    if (value instanceof RegExp) {
      return { type: 'RegExp', value: value.toString() };
    }

    // Error
    if (value instanceof Error) {
      return serializeError(value, limits, effectiveDeadline, currentDepth, visited);
    }

    // Buffer
    if (Buffer.isBuffer(value)) {
      const truncated = value.length > limits.maxStringLength;
      return {
        type: 'Buffer',
        value: value.subarray(0, limits.maxStringLength).toString('hex'),
        size: value.length,
        truncated,
      };
    }

    // Array / TypedArray
    if (Array.isArray(value)) {
      return serializeArray(value, limits, effectiveDeadline, currentDepth, visited);
    }

    // Map
    if (value instanceof Map) {
      return serializeMap(value, limits, effectiveDeadline, currentDepth, visited);
    }

    // Set
    if (value instanceof Set) {
      return serializeSet(value, limits, effectiveDeadline, currentDepth, visited);
    }

    // WeakMap / WeakSet — can't enumerate
    if (value instanceof WeakMap || value instanceof WeakSet) {
      return { type: typeOf(value), notCapturedReason: 'collectionSize' };
    }

    // Promise
    if (value instanceof Promise) {
      return { type: 'Promise', value: '<pending>' };
    }

    // Plain objects (and class instances)
    return serializeObject(obj, limits, effectiveDeadline, currentDepth, visited);
  } finally {
    visited.delete(obj);
  }
}

function serializeString(value: string, maxLength: number): CapturedValue {
  if (value.length <= maxLength) {
    return { type: 'string', value };
  }
  return {
    type: 'string',
    value: value.substring(0, maxLength),
    truncated: true,
    size: value.length,
  };
}

function serializeError(
  error: Error,
  limits: CaptureConfiguration,
  deadline: number,
  depth: number,
  visited: Set<object>
): CapturedValue {
  const fields: Record<string, CapturedValue> = {};
  fields.message = serializeValue(error.message, limits, deadline, depth + 1, visited);
  fields.name = serializeValue(error.name, limits, deadline, depth + 1, visited);
  if (error.stack) {
    fields.stack = serializeString(error.stack, limits.maxStackTraceSize);
  }
  return { type: error.constructor?.name ?? 'Error', fields };
}

function serializeArray(
  arr: unknown[],
  limits: CaptureConfiguration,
  deadline: number,
  depth: number,
  visited: Set<object>
): CapturedValue {
  const elements: CapturedValue[] = [];
  const maxWidth = limits.maxCollectionWidth;

  for (let i = 0; i < Math.min(arr.length, maxWidth); i++) {
    if (Date.now() > deadline) {
      elements.push({ type: 'unknown', notCapturedReason: 'timeout' });
      break;
    }
    elements.push(serializeValue(arr[i], limits, deadline, depth + 1, visited));
  }

  return {
    type: 'Array',
    elements,
    size: arr.length,
    truncated: arr.length > maxWidth,
  };
}

function serializeMap(
  map: Map<unknown, unknown>,
  limits: CaptureConfiguration,
  deadline: number,
  depth: number,
  visited: Set<object>
): CapturedValue {
  const entries: Array<[CapturedValue, CapturedValue]> = [];
  const maxWidth = limits.maxCollectionWidth;
  let count = 0;

  for (const [k, v] of map) {
    if (count >= maxWidth) break;
    if (Date.now() > deadline) break;
    entries.push([
      serializeValue(k, limits, deadline, depth + 1, visited),
      serializeValue(v, limits, deadline, depth + 1, visited),
    ]);
    count++;
  }

  return {
    type: 'Map',
    entries,
    size: map.size,
    truncated: map.size > maxWidth,
  };
}

function serializeSet(
  set: Set<unknown>,
  limits: CaptureConfiguration,
  deadline: number,
  depth: number,
  visited: Set<object>
): CapturedValue {
  const elements: CapturedValue[] = [];
  const maxWidth = limits.maxCollectionWidth;
  let count = 0;

  for (const item of set) {
    if (count >= maxWidth) break;
    if (Date.now() > deadline) break;
    elements.push(serializeValue(item, limits, deadline, depth + 1, visited));
    count++;
  }

  return {
    type: 'Set',
    elements,
    size: set.size,
    truncated: set.size > maxWidth,
  };
}

function serializeObject(
  obj: object,
  limits: CaptureConfiguration,
  deadline: number,
  depth: number,
  visited: Set<object>
): CapturedValue {
  const fields: Record<string, CapturedValue> = {};
  const maxFields = limits.maxFieldsPerObject;

  let keys: string[];
  try {
    keys = Object.keys(obj);
  } catch {
    return { type: typeOf(obj), notCapturedReason: 'fieldCount' };
  }

  let fieldCount = 0;
  for (const key of keys) {
    if (fieldCount >= maxFields) break;
    if (Date.now() > deadline) {
      fields[key] = { type: 'unknown', notCapturedReason: 'timeout' };
      break;
    }

    try {
      const val = (obj as Record<string, unknown>)[key];
      fields[key] = serializeValue(val, limits, deadline, depth + 1, visited);
    } catch {
      fields[key] = { type: 'unknown', notCapturedReason: 'fieldCount' };
    }
    fieldCount++;
  }

  const typeName = obj.constructor?.name ?? 'Object';
  const result: CapturedValue = { type: typeName, fields };
  if (keys.length > maxFields) {
    result.truncated = true;
    result.size = keys.length;
  }
  return result;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'Array';
  const t = typeof value;
  if (t === 'object') {
    return (value as object).constructor?.name ?? 'Object';
  }
  return t;
}
