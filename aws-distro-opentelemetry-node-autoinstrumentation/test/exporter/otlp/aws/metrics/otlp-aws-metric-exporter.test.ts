// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import expect from 'expect';
import * as http from 'http';
import * as nock from 'nock';
import * as sinon from 'sinon';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import {
  AggregationTemporality,
  AggregationType,
  DataPointType,
  InstrumentType,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { ValueType } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPAwsBaseExporterTest } from '../common/otlp-aws-base-exporter.test';
import { OTLPAwsMetricExporter } from '../../../../../src/exporter/otlp/aws/metrics/otlp-aws-metric-exporter';
import { getNodeVersion } from '../../../../../src/utils';

// Sigv4 is only enabled for node version >= 16
const version = getNodeVersion();

const METRICS_ENDPOINT = 'https://monitoring.us-east-1.amazonaws.com';
const METRICS_PATH = '/v1/metrics';

const emptyResourceMetrics = (): ResourceMetrics => ({
  resource: resourceFromAttributes({}),
  scopeMetrics: [],
});

class OTLPAwsMetricExporterTest extends OTLPAwsBaseExporterTest<ResourceMetrics> {
  // One cumulative counter data point per name, so each payload serializes to distinct bytes.
  protected override createPayload(names: string[]): ResourceMetrics {
    return {
      resource: resourceFromAttributes({}),
      scopeMetrics: [
        {
          scope: { name: 'exporter-test' },
          metrics: names.map(name => ({
            descriptor: { name, description: '', unit: '', type: InstrumentType.COUNTER, valueType: ValueType.INT },
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            dataPointType: DataPointType.SUM,
            isMonotonic: true,
            dataPoints: [{ startTime: [0, 0], endTime: [1, 0], attributes: {}, value: 1 }],
          })),
        },
      ],
    };
  }

  protected override getExporter() {
    return OTLPAwsMetricExporter;
  }

  protected getEndpoint(): string {
    return METRICS_ENDPOINT;
  }

  protected getEndpointPath(): string {
    return METRICS_PATH;
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

/**
 * Wire-level coverage for the metrics SigV4 path.
 *
 * The selection tests in aws-opentelemetry-configurator.test.ts assert which exporter object is
 * returned, which leaves the resulting HTTP request inferred rather than observed. These assert what
 * actually reaches the server: exactly one Authorization value, carrying the monitoring signing
 * service.
 *
 * Uses the real AwsAuthenticator with fake static credentials. No AWS account is involved.
 */

interface TestServer {
  url: string;
  /** Every Authorization value per request, read from rawHeaders. */
  received: string[][];
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const received: string[][] = [];

  const server = http.createServer((req, res) => {
    // rawHeaders preserves repeated header names. req.headers would collapse them, which would hide
    // a duplicate Authorization and make a count of one meaningless.
    const values: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'authorization') {
        values.push(req.rawHeaders[i + 1]);
      }
    }
    received.push(values);

    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/v1/metrics`,
    received,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

describe('OTLPAwsMetricExporter wire behavior', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const managedEnv = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_EC2_METADATA_DISABLED',
    'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
    'OTEL_EXPORTER_OTLP_HEADERS',
  ];

  before(() => {
    managedEnv.forEach(name => (savedEnv[name] = process.env[name]));

    // Fake static credentials so the real signer resolves deterministically, with no account or
    // instance metadata involved.
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
    process.env.AWS_EC2_METADATA_DISABLED = 'true';

    // These tests need real sockets.
    nock.cleanAll();
    if (nock.isActive()) {
      nock.restore();
    }
  });

  after(() => {
    managedEnv.forEach(name => {
      if (savedEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[name];
      }
    });

    if (!nock.isActive()) {
      nock.activate();
    }
  });

  it('should observe multiple Authorization values when they are present', async () => {
    // Control case. Without this, "exactly one value" could be an artifact of a harness that can only
    // ever see one.
    const server = await startServer();

    try {
      await new Promise<void>(resolve => {
        const request = http.request(
          server.url,
          { method: 'POST', headers: { authorization: ['Bearer one', 'Bearer two'] } },
          response => {
            response.resume();
            response.on('end', () => resolve());
          }
        );
        request.end();
      });

      expect(server.received).toHaveLength(1);
      expect(server.received[0]).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('should send exactly one Authorization header, signed for the monitoring service', async () => {
    if (version < 16) {
      return;
    }

    const server = await startServer();

    try {
      const exporter = new OTLPAwsMetricExporter(server.url);

      const result = await new Promise<ExportResult>(resolve =>
        exporter.export(emptyResourceMetrics(), exportResult => resolve(exportResult))
      );

      expect(result.code).toBe(ExportResultCode.SUCCESS);

      // Guard against a vacuous pass.
      expect(server.received).toHaveLength(1);

      const authorizationValues = server.received[0];
      expect(authorizationValues).toHaveLength(1);
      expect(authorizationValues[0]).toMatch(/^AWS4-HMAC-SHA256 /);
      // The signing service is what distinguishes metrics from the xray and logs exporters.
      expect(authorizationValues[0]).toContain('/monitoring/aws4_request');
    } finally {
      await server.close();
    }
  });

  it('should replace a stale Authorization header rather than sending both', async () => {
    if (version < 16) {
      return;
    }

    const server = await startServer();

    try {
      // A bearer reaching this exporter is a misconfiguration: the configurator skips SigV4 when one
      // is set for the signal. Assert the exporter still emits a single value, so a bearer that slips
      // through cannot produce the duplicate-header failure seen in other distributions.
      process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'Authorization=Bearer%20should-be-replaced';

      const exporter = new OTLPAwsMetricExporter(server.url);

      await new Promise<ExportResult>(resolve =>
        exporter.export(emptyResourceMetrics(), exportResult => resolve(exportResult))
      );

      expect(server.received).toHaveLength(1);
      expect(server.received[0]).toHaveLength(1);
      expect(server.received[0][0]).toMatch(/^AWS4-HMAC-SHA256 /);
    } finally {
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS;
      await server.close();
    }
  });
});
