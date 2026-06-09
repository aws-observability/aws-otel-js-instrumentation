// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPAwsBaseExporterTest } from '../common/otlp-aws-base-exporter.test';
import { OTLPAwsSpanExporter } from '../../../../../src/exporter/otlp/aws/traces/otlp-aws-span-exporter';
import expect from 'expect';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';

class OTLPAwsSpanExporterTest extends OTLPAwsBaseExporterTest {
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
