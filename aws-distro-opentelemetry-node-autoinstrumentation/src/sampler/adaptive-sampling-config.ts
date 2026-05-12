// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

export enum UsageType {
  BOTH = 'both',
  SAMPLING_BOOST = 'sampling-boost',
  ANOMALY_TRACE_CAPTURE = 'anomaly_trace_capture',
  NEITHER = 'neither',
}

export interface AnomalyCondition {
  errorCodeRegex?: string;
  operations?: string[];
  highLatencyMs?: number;
  usage: UsageType;
}

export interface AnomalyCaptureLimit {
  anomalyTracesPerSecond: number;
}

export interface AdaptiveSamplingConfig {
  version: number;
  anomalyConditions?: AnomalyCondition[];
  anomalyCaptureLimit?: AnomalyCaptureLimit;
}

export const AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG_ENV = 'AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG';

export function parseAdaptiveSamplingConfig(envValue?: string): AdaptiveSamplingConfig | undefined {
  if (!envValue || envValue.trim() === '') {
    return undefined;
  }

  let rawConfig: unknown;
  try {
    const trimmed = envValue.trim();
    // If it looks like a file path (doesn't start with { and exists on disk), read from file
    if (!trimmed.startsWith('{') && fs.existsSync(trimmed)) {
      const fileContent = fs.readFileSync(trimmed, 'utf-8');
      rawConfig = yaml.load(fileContent);
    } else {
      rawConfig = yaml.load(trimmed);
    }
  } catch (e) {
    diag.warn(`Failed to parse AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: ${e}`);
    return undefined;
  }

  return validateConfig(rawConfig);
}

function validateConfig(raw: unknown): AdaptiveSamplingConfig | undefined {
  if (!raw || typeof raw !== 'object') {
    diag.warn('AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: config must be an object');
    return undefined;
  }

  const obj = raw as Record<string, unknown>;

  // Validate version
  const version = Number(obj['version']);
  if (isNaN(version) || version < 1.0 || version >= 2.0) {
    diag.warn(`AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: version must be >= 1.0 and < 2.0, got: ${obj['version']}`);
    return undefined;
  }

  // Validate anomalyConditions
  let anomalyConditions: AnomalyCondition[] | undefined;
  if (obj['anomalyConditions'] !== undefined) {
    if (!Array.isArray(obj['anomalyConditions'])) {
      diag.warn('AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: anomalyConditions must be an array');
      return undefined;
    }
    anomalyConditions = [];
    for (const cond of obj['anomalyConditions']) {
      const parsed = validateAnomalyCondition(cond);
      if (!parsed) return undefined;
      anomalyConditions.push(parsed);
    }
  }

  // Validate anomalyCaptureLimit
  let anomalyCaptureLimit: AnomalyCaptureLimit | undefined;
  if (obj['anomalyCaptureLimit'] !== undefined) {
    const limit = obj['anomalyCaptureLimit'] as Record<string, unknown>;
    const tps = Number(limit['anomalyTracesPerSecond']);
    if (!Number.isInteger(tps) || tps < 0) {
      diag.warn(
        `AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: anomalyTracesPerSecond must be a non-negative integer, got: ${limit['anomalyTracesPerSecond']}`
      );
      return undefined;
    }
    anomalyCaptureLimit = { anomalyTracesPerSecond: tps };
  }

  return { version, anomalyConditions, anomalyCaptureLimit };
}

function validateAnomalyCondition(raw: unknown): AnomalyCondition | undefined {
  if (!raw || typeof raw !== 'object') {
    diag.warn('AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: each anomaly condition must be an object');
    return undefined;
  }

  const obj = raw as Record<string, unknown>;

  // Validate usage
  const usageStr = String(obj['usage'] || '');
  const validUsages = Object.values(UsageType) as string[];
  if (!validUsages.includes(usageStr)) {
    diag.warn(`AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: invalid usage type: ${usageStr}`);
    return undefined;
  }
  const usage = usageStr as UsageType;

  const condition: AnomalyCondition = { usage };

  if (obj['errorCodeRegex'] !== undefined) {
    if (typeof obj['errorCodeRegex'] !== 'string') {
      diag.warn('AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: errorCodeRegex must be a string');
      return undefined;
    }
    try {
      new RegExp(obj['errorCodeRegex']);
    } catch (e) {
      diag.warn(`AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: invalid errorCodeRegex: ${e}`);
      return undefined;
    }
    condition.errorCodeRegex = obj['errorCodeRegex'];
  }

  if (obj['operations'] !== undefined) {
    if (!Array.isArray(obj['operations'])) {
      diag.warn('AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: operations must be an array');
      return undefined;
    }
    condition.operations = obj['operations'].map(String);
  }

  if (obj['highLatencyMs'] !== undefined) {
    const val = Number(obj['highLatencyMs']);
    if (!Number.isInteger(val) || val <= 0) {
      diag.warn('AWS_XRAY_ADAPTIVE_SAMPLING_CONFIG: highLatencyMs must be a positive integer');
      return undefined;
    }
    condition.highLatencyMs = val;
  }

  return condition;
}
