// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Capture configuration defining what data to capture and within what limits.
 * Parsed from the CaptureConfiguration.CodeCapture union in the API response.
 *
 * All numeric limits are clamped to safe min/max ranges to prevent abuse or misconfiguration.
 */
export interface CaptureConfiguration {
  captureReturn: boolean;
  captureStackTrace: boolean;
  captureArguments: string[] | null; // null = field absent (do not capture), [] = capture all
  captureLocals: string[] | null; // null = field absent (do not capture), [] = capture all
  argMappings: Record<string, string>;
  returnAttributeName: string;
  maxStringLength: number;
  maxCollectionWidth: number;
  maxCollectionDepth: number;
  maxStackFrames: number;
  maxStackTraceSize: number;
  maxObjectDepth: number;
  maxFieldsPerObject: number;
}

const DEFAULTS = {
  captureReturn: false,
  captureStackTrace: false,
  captureArguments: null as string[] | null,
  captureLocals: null as string[] | null,
  argMappings: {} as Record<string, string>,
  returnAttributeName: 'aws.di.return_value',
  maxStringLength: 255,
  maxCollectionWidth: 20,
  maxCollectionDepth: 3,
  maxStackFrames: 20,
  maxStackTraceSize: 200,
  maxObjectDepth: 3,
  maxFieldsPerObject: 20,
};

// Ranges aligned with Java implementation to prevent resource exhaustion
const RANGES: Record<string, { min: number; max: number }> = {
  maxStringLength: { min: 1, max: 255 },
  maxCollectionWidth: { min: 1, max: 20 },
  maxCollectionDepth: { min: 1, max: 5 },
  maxStackFrames: { min: 1, max: 20 },
  maxStackTraceSize: { min: 1, max: 1000 },
  maxObjectDepth: { min: 1, max: 5 },
  maxFieldsPerObject: { min: 1, max: 20 },
};

function clamp(value: number, field: string): number {
  const range = RANGES[field];
  if (!range) return value;
  if (value < range.min) return range.min;
  if (value > range.max) return range.max;
  return value;
}

function safeInt(value: unknown, defaultValue: number): number {
  if (value === null || value === undefined) return defaultValue;
  const num = typeof value === 'number' ? value : Number(value);
  if (isNaN(num) || !isFinite(num)) return defaultValue;
  return Math.floor(num);
}

function safeBool(value: unknown, defaultValue: boolean): boolean {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return defaultValue;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function safeStringMap(value: unknown): Record<string, string> {
  if (value === null || value === undefined || typeof value !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Parse CaptureConfiguration from API response JSON.
 *
 * The API wraps capture config in a union: { "CodeCapture": {...} }.
 * This function handles unwrapping CodeCapture.
 *
 * Each field is parsed independently to isolate errors (per Code Review Guidelines #4).
 */
export function parseCaptureConfiguration(raw: Record<string, unknown> | null | undefined): CaptureConfiguration {
  if (!raw) return { ...DEFAULTS };

  // Unwrap CodeCapture from union if present
  const captureData = (raw.CodeCapture as Record<string, unknown>) ?? raw;

  // Parse capture limits from CaptureLimits sub-object
  const limits = (captureData.CaptureLimits as Record<string, unknown>) ?? {};

  const config: CaptureConfiguration = {
    captureReturn: safeBool(captureData.CaptureReturn, DEFAULTS.captureReturn),
    captureStackTrace: safeBool(captureData.CaptureStackTrace, DEFAULTS.captureStackTrace),
    captureArguments: 'CaptureArguments' in captureData ? safeStringArray(captureData.CaptureArguments) : null,
    captureLocals: 'CaptureLocals' in captureData ? safeStringArray(captureData.CaptureLocals) : null,
    argMappings: safeStringMap(captureData.ArgMappings),
    returnAttributeName:
      typeof captureData.ReturnAttributeName === 'string' && captureData.ReturnAttributeName.trim()
        ? captureData.ReturnAttributeName.trim()
        : DEFAULTS.returnAttributeName,
    maxStringLength: clamp(safeInt(limits.MaxStringLength, DEFAULTS.maxStringLength), 'maxStringLength'),
    maxCollectionWidth: clamp(safeInt(limits.MaxCollectionWidth, DEFAULTS.maxCollectionWidth), 'maxCollectionWidth'),
    maxCollectionDepth: clamp(safeInt(limits.MaxCollectionDepth, DEFAULTS.maxCollectionDepth), 'maxCollectionDepth'),
    maxStackFrames: clamp(safeInt(limits.MaxStackFrames, DEFAULTS.maxStackFrames), 'maxStackFrames'),
    maxStackTraceSize: clamp(safeInt(limits.MaxStackTraceSize, DEFAULTS.maxStackTraceSize), 'maxStackTraceSize'),
    maxObjectDepth: clamp(safeInt(limits.MaxObjectDepth, DEFAULTS.maxObjectDepth), 'maxObjectDepth'),
    maxFieldsPerObject: clamp(safeInt(limits.MaxFieldsPerObject, DEFAULTS.maxFieldsPerObject), 'maxFieldsPerObject'),
  };

  return config;
}

export const CAPTURE_DEFAULTS = DEFAULTS;
export const CAPTURE_RANGES = RANGES;
