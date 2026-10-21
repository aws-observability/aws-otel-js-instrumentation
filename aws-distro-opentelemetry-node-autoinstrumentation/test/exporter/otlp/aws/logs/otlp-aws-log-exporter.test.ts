// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { OTLPAwsBaseExporterTest } from '../common/otlp-aws-base-exporter.test';
import { OTLPAwsLogExporter } from '../../../../../src/exporter/otlp/aws/logs/otlp-aws-log-exporter';
import { LoggerProvider, ReadableLogRecord } from '@opentelemetry/sdk-logs';

class OTLPAwsLogExporterTest extends OTLPAwsBaseExporterTest<ReadableLogRecord[]> {
  protected override createPayload(names: string[]): ReadableLogRecord[] {
    const records: ReadableLogRecord[] = [];
    const provider = new LoggerProvider({
      processors: [
        {
          onEmit: record => {
            records.push(record);
          },
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
        },
      ],
    });
    const logger = provider.getLogger('exporter-test');
    names.forEach(name => logger.emit({ body: name }));
    return records;
  }

  protected override getExporter() {
    return OTLPAwsLogExporter;
  }
  protected getEndpoint(): string {
    return 'https://logs.us-east-1.amazonaws.com';
  }

  protected getEndpointPath(): string {
    return '/v1/logs';
  }
}

describe('OTLPAwsLogExporter', () => {
  const test = new OTLPAwsLogExporterTest();

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
});
