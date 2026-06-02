// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import { parseAdaptiveSamplingConfig, UsageType } from '../../src/sampler/adaptive-sampling-config';

describe('AdaptiveSamplingConfig', () => {
  describe('parseAdaptiveSamplingConfig', () => {
    it('returns undefined for empty string', () => {
      expect(parseAdaptiveSamplingConfig('')).toBeUndefined();
      expect(parseAdaptiveSamplingConfig(undefined)).toBeUndefined();
      expect(parseAdaptiveSamplingConfig('   ')).toBeUndefined();
    });

    it('parses valid JSON config', () => {
      const config = parseAdaptiveSamplingConfig(
        '{"version":"1.0","anomalyConditions":[{"errorCodeRegex":"5[0-9]{2}","usage":"both"}]}'
      );
      expect(config).toBeDefined();
      expect(config!.version).toBe(1.0);
      expect(config!.anomalyConditions).toHaveLength(1);
      expect(config!.anomalyConditions![0].errorCodeRegex).toBe('5[0-9]{2}');
      expect(config!.anomalyConditions![0].usage).toBe(UsageType.BOTH);
    });

    it('rejects config without version', () => {
      const config = parseAdaptiveSamplingConfig('{"anomalyConditions":[]}');
      expect(config).toBeUndefined();
    });

    it('rejects config with invalid version', () => {
      expect(parseAdaptiveSamplingConfig('{"version":"2.0"}')).toBeUndefined();
      expect(parseAdaptiveSamplingConfig('{"version":"0.5"}')).toBeUndefined();
    });

    it('parses all valid usage types', () => {
      const template = (usage: string) =>
        `{"version":"1.0","anomalyConditions":[{"errorCodeRegex":"5xx","usage":"${usage}"}]}`;

      const both = parseAdaptiveSamplingConfig(template('both'));
      expect(both!.anomalyConditions![0].usage).toBe(UsageType.BOTH);

      const boost = parseAdaptiveSamplingConfig(template('sampling-boost'));
      expect(boost!.anomalyConditions![0].usage).toBe(UsageType.SAMPLING_BOOST);

      const capture = parseAdaptiveSamplingConfig(template('anomaly-trace-capture'));
      expect(capture!.anomalyConditions![0].usage).toBe(UsageType.ANOMALY_TRACE_CAPTURE);

      const neither = parseAdaptiveSamplingConfig(template('neither'));
      expect(neither!.anomalyConditions![0].usage).toBe(UsageType.NEITHER);
    });

    it('rejects invalid usage type', () => {
      const config = parseAdaptiveSamplingConfig(
        '{"version":"1.0","anomalyConditions":[{"errorCodeRegex":"5xx","usage":"BOOST_AND_CAPTURE"}]}'
      );
      expect(config).toBeUndefined();
    });

    it('parses anomalyCaptureLimit', () => {
      const config = parseAdaptiveSamplingConfig(
        '{"version":"1.0","anomalyCaptureLimit":{"anomalyTracesPerSecond":5}}'
      );
      expect(config).toBeDefined();
      expect(config!.anomalyCaptureLimit!.anomalyTracesPerSecond).toBe(5);
    });

    it('parses highLatencyMs condition', () => {
      const config = parseAdaptiveSamplingConfig(
        '{"version":"1.0","anomalyConditions":[{"highLatencyMs":1000,"usage":"both"}]}'
      );
      expect(config!.anomalyConditions![0].highLatencyMs).toBe(1000);
    });

    it('parses operations filter', () => {
      const config = parseAdaptiveSamplingConfig(
        '{"version":"1.0","anomalyConditions":[{"errorCodeRegex":"5xx","operations":["GET /api","POST /login"],"usage":"both"}]}'
      );
      expect(config!.anomalyConditions![0].operations).toEqual(['GET /api', 'POST /login']);
    });

    it('rejects invalid regex', () => {
      const config = parseAdaptiveSamplingConfig(
        '{"version":"1.0","anomalyConditions":[{"errorCodeRegex":"[invalid","usage":"both"}]}'
      );
      expect(config).toBeUndefined();
    });
  });
});
