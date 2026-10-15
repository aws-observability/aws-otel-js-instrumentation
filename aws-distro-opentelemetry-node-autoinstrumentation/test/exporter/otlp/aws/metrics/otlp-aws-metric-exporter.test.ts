// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import expect from 'expect';
import * as sinon from 'sinon';
import { AggregationTemporality, AggregationType, InstrumentType, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPAwsBaseExporterTest } from '../common/otlp-aws-base-exporter.test';
import { OTLPAwsMetricExporter } from '../../../../../src/exporter/otlp/aws/metrics/otlp-aws-metric-exporter';

const METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com';
const METRICS_PATH = '/v1/metrics';

const emptyResourceMetrics = (): ResourceMetrics => ({
  resource: resourceFromAttributes({}),
  scopeMetrics: [],
});

class OTLPAwsMetricExporterTest extends OTLPAwsBaseExporterTest {
  protected override getExporter() {
    return OTLPAwsMetricExporter;
  }

  protected getEndpoint(): string {
    return METRICS_ENDPOINT;
  }

  protected getEndpointPath(): string {
    return METRICS_PATH;
  }

  // The metrics serializer requires a ResourceMetrics object; an array throws.
  protected override getPayload(): any {
    return emptyResourceMetrics();
  }
}

describe('OTLPAwsMetricExporter', () => {
  const test = new OTLPAwsMetricExporterTest();

  beforeEach(() => {
    test.beforeEach();
  });

  afterEach(() => {
    test.afterEach();
  });

  test.testCommon().forEach(testCase => {
    it(testCase.description, done => {
      testCase.test(done);
    });
  });

  describe('metric settings delegation', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE;
    });

    // selectAggregationTemporality and selectAggregation are optional on PushMetricExporter, so a
    // wrapper that omits them still compiles and the reader then silently falls back to cumulative.
    // These assert the delegation rather than leaving it to inspection.
    it('should delegate the configured temporality preference to the wrapped exporter', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'delta';

      const exporter = new OTLPAwsMetricExporter(METRICS_ENDPOINT + METRICS_PATH);

      expect(exporter.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(AggregationTemporality.DELTA);
      expect(exporter.selectAggregationTemporality(InstrumentType.HISTOGRAM)).toBe(AggregationTemporality.DELTA);
    });

    it('should delegate the default cumulative temporality when none is configured', () => {
      const exporter = new OTLPAwsMetricExporter(METRICS_ENDPOINT + METRICS_PATH);

      expect(exporter.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(AggregationTemporality.CUMULATIVE);
    });

    it('should delegate the aggregation preference to the wrapped exporter', () => {
      const exporter = new OTLPAwsMetricExporter(METRICS_ENDPOINT + METRICS_PATH);

      expect(exporter.selectAggregation(InstrumentType.COUNTER)).toEqual({ type: AggregationType.DEFAULT });
    });
  });
});
