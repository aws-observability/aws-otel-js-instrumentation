// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as http from 'http';
import { createHash } from 'crypto';
import * as nock from 'nock';
import * as sinon from 'sinon';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { BasicTracerProvider, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AwsAuthenticator } from '../../../../../src/exporter/otlp/aws/common/aws-authenticator';
import { OTLPAwsSpanExporter } from '../../../../../src/exporter/otlp/aws/traces/otlp-aws-span-exporter';

/**
 * These tests cover a concurrency defect in OTLPAwsBaseExporter: per-request state (the serialized
 * body and the signed headers) was kept on objects shared by every export, so overlapping exports
 * could send one batch's body with another batch's signature, or send the same batch twice while
 * silently dropping another.
 *
 * Exports overlap in practice whenever BatchSpanProcessorBase._flushAll() runs, because it exports
 * every queued batch in parallel. That happens on forceFlush() and on shutdown().
 *
 * Unlike the other exporter tests, these use a real HTTP server rather than nock, because the defect
 * is only observable by comparing what arrived on the wire against what the signature was computed
 * for.
 */

const sha256 = (data: Uint8Array | Buffer): string => createHash('sha256').update(data).digest('hex');

interface ReceivedRequest {
  /** sha256 of the body the server actually received. */
  bodyHash: string;
  /** sha256 the request was signed for, taken from the x-amz-content-sha256 header. */
  signedHash: string | undefined;
}

interface TestServer {
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

/**
 * A local HTTP server that records, for every request, the hash of the body it received and the
 * payload hash the request was signed for. Real SigV4 binds a signature to its payload through
 * x-amz-content-sha256, so bodyHash !== signedHash is exactly the condition AWS rejects with
 * "The request signature we calculated does not match the signature you provided".
 */
async function startServer(): Promise<TestServer> {
  const received: ReceivedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        bodyHash: sha256(Buffer.concat(chunks)),
        signedHash: req.headers['x-amz-content-sha256'] as string | undefined,
      });
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    received,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Produces real ReadableSpans, which the protobuf serializer requires. */
function createSpans(count: number): ReadableSpan[] {
  const ended: ReadableSpan[] = [];
  const capturingProcessor: SpanProcessor = {
    onStart: () => {},
    onEnd: span => ended.push(span),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  const provider = new BasicTracerProvider({ spanProcessors: [capturingProcessor] });
  const tracer = provider.getTracer('concurrency-test');

  for (let i = 0; i < count; i++) {
    tracer.startSpan(`span-${i}`).end();
  }

  return ended;
}

describe('OTLPAwsBaseExporter concurrency', () => {
  let sandbox: sinon.SinonSandbox;

  before(() => {
    // These tests need real sockets, so stop nock from intercepting http for this file only.
    nock.cleanAll();
    if (nock.isActive()) {
      nock.restore();
    }
  });

  after(() => {
    // Hand interception back to the rest of the suite.
    if (!nock.isActive()) {
      nock.activate();
    }
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    // Stand in for real SigV4 signing: bind the "signature" to the exact bytes handed to the
    // signer, and yield at least once so exports can interleave the way they do with real signing.
    // No AWS credentials are needed, and the payload-binding invariant is preserved.
    sandbox
      .stub(AwsAuthenticator.prototype, 'authenticate')
      .callsFake(async (headers: Record<string, string>, serializedData: Uint8Array | undefined) => {
        await Promise.resolve();
        const payloadHash = serializedData ? sha256(serializedData) : 'no-data';
        return {
          ...headers,
          authorization: `AWS4-HMAC-SHA256 payload=${payloadHash}`,
          'x-amz-date': '20260101T000000Z',
          'x-amz-content-sha256': payloadHash,
        };
      });
  });

  afterEach(() => {
    sandbox.restore();
  });

  /**
   * Asserts that every batch arrived exactly once, carrying its own signature.
   * `signedHash` is reported separately so a mismatch is distinguishable from a lost batch.
   */
  function assertEachBatchDeliveredOnce(batches: ReadableSpan[][], server: TestServer) {
    const expectedHashes = batches.map(batch => sha256(ProtobufTraceSerializer.serializeRequest(batch)!));
    const label = (hash: string | undefined) => {
      const index = expectedHashes.findIndex(expected => expected === hash);
      return index === -1 ? `unknown(${String(hash).slice(0, 8)})` : `batch${index + 1}`;
    };

    // Guard against a vacuous pass: a test where nothing arrives must fail.
    expect(server.received.length).toBe(batches.length);

    const mismatched = server.received.filter(request => request.bodyHash !== request.signedHash);
    expect(
      mismatched.map(request => `body ${label(request.bodyHash)} signed for ${label(request.signedHash)}`)
    ).toEqual([]);

    const deliveredLabels = server.received.map(request => label(request.bodyHash)).sort();
    const expectedLabels = batches.map((_, index) => `batch${index + 1}`).sort();
    expect(deliveredLabels).toEqual(expectedLabels);
  }

  it('should not mix bodies or signatures when two exports overlap', async () => {
    const server = await startServer();
    const spans = createSpans(2);
    const batches = [[spans[0]], [spans[1]]];

    try {
      const exporter = new OTLPAwsSpanExporter(server.url);

      // Start both exports without awaiting the first, which is what _flushAll() does.
      const results = await Promise.all(
        batches.map(
          batch => new Promise<ExportResult>(resolve => void exporter.export(batch, result => resolve(result)))
        )
      );

      expect(results.map(result => result.code)).toEqual([ExportResultCode.SUCCESS, ExportResultCode.SUCCESS]);
      assertEachBatchDeliveredOnce(batches, server);
    } finally {
      await server.close();
    }
  });

  it('should deliver every batch when a flush exports three batches concurrently', async () => {
    const server = await startServer();
    const spans = createSpans(30);
    const batches = [spans.slice(0, 10), spans.slice(10, 20), spans.slice(20)];

    try {
      const exporter = new OTLPAwsSpanExporter(server.url);

      const results = await Promise.all(
        batches.map(
          batch => new Promise<ExportResult>(resolve => void exporter.export(batch, result => resolve(result)))
        )
      );

      expect(results.every(result => result.code === ExportResultCode.SUCCESS)).toBe(true);
      assertEachBatchDeliveredOnce(batches, server);
    } finally {
      await server.close();
    }
  });

  it('should deliver every batch when exports do not overlap', async () => {
    // Control case. This passes with or without the fix, and proves the harness itself is sound:
    // if this failed, a pass on the tests above would be meaningless.
    const server = await startServer();
    const spans = createSpans(3);
    const batches = [[spans[0]], [spans[1]], [spans[2]]];

    try {
      const exporter = new OTLPAwsSpanExporter(server.url);

      for (const batch of batches) {
        await new Promise<ExportResult>(resolve => void exporter.export(batch, result => resolve(result)));
      }

      assertEachBatchDeliveredOnce(batches, server);
    } finally {
      await server.close();
    }
  });

  it('should finish queued exports before forceFlush resolves', async () => {
    const server = await startServer();
    const spans = createSpans(2);
    const batches = [[spans[0]], [spans[1]]];

    try {
      const exporter = new OTLPAwsSpanExporter(server.url);

      batches.forEach(batch => void exporter.export(batch, () => {}));
      await exporter.forceFlush();

      assertEachBatchDeliveredOnce(batches, server);
    } finally {
      await server.close();
    }
  });
});
