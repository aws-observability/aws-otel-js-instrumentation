// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPAwsBaseExporterTest } from '../common/otlp-aws-base-exporter.test';
import { OTLPAwsSpanExporter } from '../../../../../src/exporter/otlp/aws/traces/otlp-aws-span-exporter';
import expect from 'expect';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { BasicTracerProvider, ReadableSpan } from '@opentelemetry/sdk-trace-base';

class OTLPAwsSpanExporterTest extends OTLPAwsBaseExporterTest<ReadableSpan[]> {
  protected override createPayload(names: string[]): ReadableSpan[] {
    const spans: ReadableSpan[] = [];
    const provider = new BasicTracerProvider({
      spanProcessors: [
        {
          onStart: () => {},
          onEnd: span => {
            spans.push(span);
          },
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
        },
      ],
    });
    const tracer = provider.getTracer('exporter-test');
    names.forEach(name => tracer.startSpan(name).end());
    return spans;
  }

  protected override getExporter() {
    return OTLPAwsSpanExporter;
  }
  protected getEndpoint(): string {
    return 'https://xray.us-east-1.amazonaws.com';
  }

  protected getEndpointPath(): string {
    return '/v1/traces';
  }
}

describe('OTLPAwsSpanExporter', () => {
  const test = new OTLPAwsSpanExporterTest();

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

  it('export succeeds with empty spans', done => {
    const exporter = new OTLPAwsSpanExporter('https://xray.us-east-1.amazonaws.com/v1/traces');

    exporter.export([], (result: ExportResult) => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      done();
    });
  });
});
