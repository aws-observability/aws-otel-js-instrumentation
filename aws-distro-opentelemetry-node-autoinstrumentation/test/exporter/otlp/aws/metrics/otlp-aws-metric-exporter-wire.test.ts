// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as http from 'http';
import * as nock from 'nock';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPAwsMetricExporter } from '../../../../../src/exporter/otlp/aws/metrics/otlp-aws-metric-exporter';
import { getNodeVersion } from '../../../../../src/utils';

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

// Sigv4 is only enabled for node version >= 16
const version = getNodeVersion();

const emptyResourceMetrics = (): ResourceMetrics => ({
  resource: resourceFromAttributes({}),
  scopeMetrics: [],
});

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
