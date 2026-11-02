// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { emptyResource } from '@opentelemetry/resources';
import expect from 'expect';
import * as sinon from 'sinon';
import { AwsMetricAttributeGenerator } from '../src/aws-metric-attribute-generator';
import { AwsMetricAttributesSpanExporter } from '../src/aws-metric-attributes-span-exporter';
import { AwsMetricAttributesSpanExporterBuilder } from '../src/aws-metric-attributes-span-exporter-builder';

describe('AwsMetricAttributesSpanExporterBuilderTest', () => {
  it('BasicTest', () => {
    const generator: AwsMetricAttributeGenerator = sinon.createStubInstance(AwsMetricAttributeGenerator);
    (generator as any).testKey = 'test';
    const builder: AwsMetricAttributesSpanExporterBuilder = AwsMetricAttributesSpanExporterBuilder.create(
      sinon.createStubInstance(OTLPHttpTraceExporter),
      emptyResource()
    );
    expect(builder.setGenerator(generator)).toBe(builder);
    const exporter: AwsMetricAttributesSpanExporter = builder.build();
    expect((exporter as any).generator.testKey).toBe('test');
  });
});
