// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPAwsBaseExporterTest } from '../common/otlp-aws-base-exporter.test';
import { OTLPAwsSpanExporter } from '../../../../../src/exporter/otlp/aws/traces/otlp-aws-span-exporter';
import expect from 'expect';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { logs } from '@opentelemetry/api-logs';

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
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
  });

  test.testCommon().forEach(testCase => {
    it(testCase.description, done => {
      testCase.test(done);
    });
  });

  it('ensureLloHandler returns false when agent observability is disabled', () => {
    const exporter = new OTLPAwsSpanExporter('https://xray.us-east-1.amazonaws.com/v1/traces');
    const result = (exporter as any).ensureLloHandler();
    expect(result).toBe(false);
    expect((exporter as any).lloHandler).toBeUndefined();
  });

  it('ensureLloHandler initializes handler when agent observability is enabled with LoggerProvider', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    const loggerProvider = new LoggerProvider();
    const exporter = new OTLPAwsSpanExporter(
      'https://xray.us-east-1.amazonaws.com/v1/traces',
      undefined,
      loggerProvider
    );

    const result = (exporter as any).ensureLloHandler();
    expect(result).toBe(true);
    expect((exporter as any).lloHandler).toBeDefined();
    loggerProvider.shutdown();
  });

  it('ensureLloHandler returns false when loggerProvider is not an SDK LoggerProvider', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    // Clear any global LoggerProvider registered by earlier test files so this
    // test observes the proxy (unset) state that the assertion requires.
    logs.disable();
    const exporter = new OTLPAwsSpanExporter('https://xray.us-east-1.amazonaws.com/v1/traces');

    const result = (exporter as any).ensureLloHandler();
    expect(result).toBe(false);
    expect((exporter as any).lloHandler).toBeUndefined();
  });

  it('export succeeds with LLO processing when agent observability is enabled', done => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    const loggerProvider = new LoggerProvider();
    const exporter = new OTLPAwsSpanExporter(
      'https://xray.us-east-1.amazonaws.com/v1/traces',
      undefined,
      loggerProvider
    );

    exporter.export([], (result: ExportResult) => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect((exporter as any).lloHandler).toBeDefined();
      loggerProvider.shutdown();
      done();
    });
  });
});
