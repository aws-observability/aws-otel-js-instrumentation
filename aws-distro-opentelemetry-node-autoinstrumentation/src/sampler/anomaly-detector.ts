// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { TTLCache } from '@isaacs/ttlcache';
import { AdaptiveSamplingConfig, AnomalyCondition, UsageType } from './adaptive-sampling-config';
import { RateLimiter } from './rate-limiter';

export const AWS_XRAY_ADAPTIVE_SAMPLING_CONFIGURED_ATTRIBUTE = 'aws.xray.adaptive_sampling_configured';
const AWS_LOCAL_OPERATION_ATTRIBUTE = 'aws.local.operation';

const TRACE_CACHE_TTL_MS = 600 * 1000;
const TRACE_CACHE_MAX_SIZE = 100_000;

export interface AnomalyMatch {
  forBoost: boolean;
  forCapture: boolean;
}

export class AnomalyDetector {
  private config: AdaptiveSamplingConfig;
  private rateLimiter: RateLimiter | undefined;
  private traceCache: TTLCache<string, boolean>;
  private compiledRegexes: Map<string, RegExp>;

  constructor(config: AdaptiveSamplingConfig) {
    this.config = config;
    this.traceCache = new TTLCache({ max: TRACE_CACHE_MAX_SIZE, ttl: TRACE_CACHE_TTL_MS });
    this.compiledRegexes = new Map();

    if (config.anomalyCaptureLimit) {
      this.rateLimiter = new RateLimiter(config.anomalyCaptureLimit.anomalyTracesPerSecond);
    }

    if (config.anomalyConditions) {
      for (const condition of config.anomalyConditions) {
        if (condition.errorCodeRegex) {
          const pattern = condition.errorCodeRegex;
          const anchored = pattern.startsWith('^') && pattern.endsWith('$') ? pattern : `^(?:${pattern})$`;
          this.compiledRegexes.set(pattern, new RegExp(anchored));
        }
      }
    }
  }

  // Python: _rule_cache.py __is_anomaly lines 217-286
  // Java: XrayRulesSampler.isAnomaly (patch lines 285-310)
  public getAnomalyMatch(span: ReadableSpan, defaultAnomalyDetectionDisabled: boolean = false): AnomalyMatch | null {
    const conditions = this.config.anomalyConditions;
    if (conditions && conditions.length > 0) {
      // OR across conditions: first matching condition determines usage flags
      for (const condition of conditions) {
        if (this.matchesCondition(condition, span)) {
          return {
            forBoost: condition.usage === UsageType.BOTH || condition.usage === UsageType.SAMPLING_BOOST,
            forCapture: condition.usage === UsageType.BOTH || condition.usage === UsageType.ANOMALY_TRACE_CAPTURE,
          };
        }
      }
    } else if (!defaultAnomalyDetectionDisabled) {
      // Default anomaly detection: 5xx status or StatusCode.ERROR
      const statusCode = span.attributes['http.status_code'] ?? span.attributes['http.response.status_code'];
      const is5xx = statusCode !== undefined && Number(statusCode) > 499;
      const isError = statusCode === undefined && span.status?.code === 2;
      if (is5xx || isError) {
        return { forBoost: true, forCapture: true };
      }
    }
    return null;
  }

  public shouldCaptureAnomaly(traceId: string): boolean {
    // If trace already flagged for capture, capture all subsequent spans too
    if (this.traceCache.has(traceId)) {
      return true;
    }

    // Rate limit: only gate on accepting new traces
    if (this.rateLimiter && !this.rateLimiter.take(1)) {
      return false;
    }

    this.traceCache.set(traceId, true);
    return true;
  }

  private matchesCondition(condition: AnomalyCondition, span: ReadableSpan): boolean {
    if (condition.usage === UsageType.NEITHER) {
      return false;
    }

    // Check operations filter
    if (condition.operations && condition.operations.length > 0) {
      const spanOperation = span.attributes[AWS_LOCAL_OPERATION_ATTRIBUTE] as string | undefined;
      if (!spanOperation || !condition.operations.includes(spanOperation)) {
        return false;
      }
    }

    // AND logic within a single condition: all specified criteria must match
    let hasAnyCriteria = false;

    if (condition.errorCodeRegex) {
      hasAnyCriteria = true;
      if (!this.matchesErrorCode(condition.errorCodeRegex, span)) {
        return false;
      }
    }

    if (condition.highLatencyMs !== undefined) {
      hasAnyCriteria = true;
      if (!this.matchesHighLatency(condition.highLatencyMs, span)) {
        return false;
      }
    }

    return hasAnyCriteria;
  }

  private matchesErrorCode(regex: string, span: ReadableSpan): boolean {
    const statusCode = this.getHttpStatusCode(span);
    if (statusCode === undefined) return false;

    const compiled = this.compiledRegexes.get(regex);
    if (!compiled) return false;
    return compiled.test(String(statusCode));
  }

  private matchesHighLatency(thresholdMs: number, span: ReadableSpan): boolean {
    const durationMs = this.getSpanDurationMs(span);
    return durationMs > thresholdMs;
  }

  private getHttpStatusCode(span: ReadableSpan): number | undefined {
    const code = span.attributes['http.status_code'] ?? span.attributes['http.response.status_code'];
    if (code === undefined) return undefined;
    const num = Number(code);
    return isNaN(num) ? undefined : num;
  }

  private getSpanDurationMs(span: ReadableSpan): number {
    const startNanos = span.startTime[0] * 1e9 + span.startTime[1];
    const endNanos = span.endTime[0] * 1e9 + span.endTime[1];
    return (endNanos - startNanos) / 1e6;
  }
}
