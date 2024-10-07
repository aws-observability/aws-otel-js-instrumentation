// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Resource } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import expect from 'expect';
import * as sinon from 'sinon';
import { AwsMetricAttributeGenerator } from '../src/aws-metric-attribute-generator';
import { AwsSpanMetricsProcessor } from '../src/aws-span-metrics-processor';
import { AwsSpanMetricsProcessorBuilder } from '../src/aws-span-metrics-processor-builder';
import { MetricAttributeGenerator } from '../src/metric-attribute-generator';

describe('AwsSpanMetricsProcessorBuilderTest', () => {
  it('TestAllMethods', () => {
    // Basic functionality tests for constructor, setters, and build(). Mostly these tests exist to validate the
    // code can be run, as the implementation is fairly trivial and does not require robust unit tests.
    const meterProvider: MeterProvider = new MeterProvider({});
    const builder: AwsSpanMetricsProcessorBuilder = AwsSpanMetricsProcessorBuilder.create(
      meterProvider,
      sinon.createStubInstance(Resource),
      meterProvider.forceFlush
    );
    const generatorMock: MetricAttributeGenerator = sinon.createStubInstance(AwsMetricAttributeGenerator);
    expect(builder.setGenerator(generatorMock)).toBe(builder);
    expect(builder.setScopeName('test')).toBe(builder);
    const metricProcessor: AwsSpanMetricsProcessor = builder.build();
    expect(metricProcessor).not.toBeUndefined();
  });
});
