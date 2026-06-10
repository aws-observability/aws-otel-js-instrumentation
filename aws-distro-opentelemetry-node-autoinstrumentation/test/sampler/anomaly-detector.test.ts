// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import { AnomalyDetector } from '../../src/sampler/anomaly-detector';
import { AdaptiveSamplingConfig, UsageType } from '../../src/sampler/adaptive-sampling-config';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

const createMockSpan = (statusCode?: string, durationMs?: number, operation?: string): ReadableSpan => {
  const attributes: Record<string, string | number> = {};
  if (statusCode) attributes['http.status_code'] = statusCode;
  if (operation) attributes['aws.local.operation'] = operation;

  return {
    attributes,
    duration: durationMs ? [0, durationMs * 1_000_000] : [0, 100_000_000],
    spanContext: () => ({ traceId: '1234', spanId: '5678', traceFlags: 0 }),
    parentSpanContext: undefined,
  } as unknown as ReadableSpan;
};

describe('AnomalyDetector', () => {
  describe('getAnomalyMatch', () => {
    it('uses default anomaly detection when no conditions configured (5xx triggers)', () => {
      const config: AdaptiveSamplingConfig = { version: 1.0 };
      const detector = new AnomalyDetector(config);
      expect(detector.getAnomalyMatch(createMockSpan('500'))).toEqual({ forBoost: true, forCapture: true });
      expect(detector.getAnomalyMatch(createMockSpan('200'))).toBeNull();
    });

    it('default anomaly detection disabled when flag is set', () => {
      const config: AdaptiveSamplingConfig = { version: 1.0 };
      const detector = new AnomalyDetector(config);
      expect(detector.getAnomalyMatch(createMockSpan('500'), true)).toBeNull();
    });

    it('matches error code regex', () => {
      const config: AdaptiveSamplingConfig = {
        version: 1.0,
        anomalyConditions: [{ errorCodeRegex: '5[0-9]{2}', usage: UsageType.BOTH }],
      };
      const detector = new AnomalyDetector(config);
      expect(detector.getAnomalyMatch(createMockSpan('500'))).toEqual({ forBoost: true, forCapture: true });
      expect(detector.getAnomalyMatch(createMockSpan('200'))).toBeNull();
    });

    it('returns forBoost=true forCapture=false for sampling-boost usage', () => {
      const config: AdaptiveSamplingConfig = {
        version: 1.0,
        anomalyConditions: [{ errorCodeRegex: '5[0-9]{2}', usage: UsageType.SAMPLING_BOOST }],
      };
      const detector = new AnomalyDetector(config);
      const match = detector.getAnomalyMatch(createMockSpan('500'));
      expect(match).toEqual({ forBoost: true, forCapture: false });
    });

    it('returns forBoost=false forCapture=true for anomaly-trace-capture usage', () => {
      const config: AdaptiveSamplingConfig = {
        version: 1.0,
        anomalyConditions: [{ errorCodeRegex: '5[0-9]{2}', usage: UsageType.ANOMALY_TRACE_CAPTURE }],
      };
      const detector = new AnomalyDetector(config);
      const match = detector.getAnomalyMatch(createMockSpan('500'));
      expect(match).toEqual({ forBoost: false, forCapture: true });
    });

    it('returns null for neither usage', () => {
      const config: AdaptiveSamplingConfig = {
        version: 1.0,
        anomalyConditions: [{ errorCodeRegex: '5[0-9]{2}', usage: UsageType.NEITHER }],
      };
      const detector = new AnomalyDetector(config);
      expect(detector.getAnomalyMatch(createMockSpan('500'))).toBeNull();
    });

    it('filters by operations', () => {
      const config: AdaptiveSamplingConfig = {
        version: 1.0,
        anomalyConditions: [{ errorCodeRegex: '5[0-9]{2}', operations: ['GET /api'], usage: UsageType.BOTH }],
      };
      const detector = new AnomalyDetector(config);
      expect(detector.getAnomalyMatch(createMockSpan('500', undefined, 'GET /api'))).not.toBeNull();
      expect(detector.getAnomalyMatch(createMockSpan('500', undefined, 'POST /other'))).toBeNull();
    });
  });

  describe('shouldCaptureAnomaly', () => {
    it('accepts trace when no rate limiter configured', () => {
      const config: AdaptiveSamplingConfig = { version: 1.0 };
      const detector = new AnomalyDetector(config);
      expect(detector.shouldCaptureAnomaly('trace-1')).toBe(true);
    });

    it('returns true for repeat traceId (already flagged)', () => {
      const config: AdaptiveSamplingConfig = { version: 1.0 };
      const detector = new AnomalyDetector(config);
      detector.shouldCaptureAnomaly('trace-1');
      // Same trace — already flagged, should still capture
      expect(detector.shouldCaptureAnomaly('trace-1')).toBe(true);
    });

    it('rate limiter rejects when no balance available', () => {
      const config: AdaptiveSamplingConfig = {
        version: 1.0,
        anomalyCaptureLimit: { anomalyTracesPerSecond: 1 },
      };
      const detector = new AnomalyDetector(config);
      // RateLimiter starts with 0 balance (floor = now), so first call fails
      expect(detector.shouldCaptureAnomaly('trace-1')).toBe(false);
    });
  });
});
