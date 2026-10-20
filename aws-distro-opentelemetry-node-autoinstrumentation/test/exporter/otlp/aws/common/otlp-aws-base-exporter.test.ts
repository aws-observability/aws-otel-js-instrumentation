// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as http from 'http';
import { createHash } from 'crypto';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import * as sinon from 'sinon';
import * as nock from 'nock';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { BasicTracerProvider, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  AUTHORIZATION_HEADER,
  AwsAuthenticator,
  X_AMZ_CONTENT_SHA256_HEADER,
  X_AMZ_DATE_HEADER,
  X_AMZ_SECURITY_TOKEN_HEADER,
} from '../../../../../src/exporter/otlp/aws/common/aws-authenticator';
import { OTLPAwsSpanExporter } from '../../../../../src/exporter/otlp/aws/traces/otlp-aws-span-exporter';

const EXPECTED_AUTH_HEADER = 'AWS4-HMAC-SHA256 Credential=test_key/some_date/us-east-1/logs/aws4_request';
const EXPECTED_X_AMZ_DATE = 'some_date';
const EXPECTED_X_AMZ_SECURITY_TOKEN = 'test_token';
const EXPECTED_X_AMZ_SHA_256 = 'test_sha256';

export abstract class OTLPAwsBaseExporterTest {
  protected sandbox!: sinon.SinonSandbox;
  protected scope!: nock.Scope;

  protected abstract getEndpoint(): string;
  protected abstract getEndpointPath(): string;
  protected abstract getExporter(): any;

  public beforeEach() {
    this.sandbox = sinon.createSandbox();

    this.scope = nock(this.getEndpoint())
      .post(this.getEndpointPath())
      .reply((uri: any, requestBody: any) => {
        return [200, ''];
      });

    // Stub AWS authenticator
    this.sandbox
      .stub(AwsAuthenticator.prototype, 'authenticate')
      .callsFake((headers: Record<string, string>, serializedData: Uint8Array | undefined) => {
        return Promise.resolve({
          ...headers,
          [AUTHORIZATION_HEADER]: EXPECTED_AUTH_HEADER,
          [X_AMZ_DATE_HEADER]: EXPECTED_X_AMZ_DATE,
          [X_AMZ_SECURITY_TOKEN_HEADER]: EXPECTED_X_AMZ_SECURITY_TOKEN,
          [X_AMZ_CONTENT_SHA256_HEADER]: EXPECTED_X_AMZ_SHA_256,
        });
      });
  }

  public afterEach() {
    this.sandbox.restore();
  }

  public testCommon(): Array<{ description: string; test: (done: () => void) => void }> {
    return [
      {
        description: 'Should inject SigV4 Headers successfully',
        test: (done: () => void) => this.testSigV4Headers(done),
      },
      {
        description: 'Should enable compression with gzip',
        test: (done: () => void) => this.testEnableCompression(done),
      },
      {
        description: 'Should call serializer and gzip only once during export',
        test: (done: () => void) => this.testSerializerAndGzipCalledOnce(done),
      },
      {
        description: 'Should fail when gzip compression throws exception',
        test: (done: () => void) => this.testGzipException(done),
      },
      {
        description: 'Should fail when serialization returns undefined',
        test: (done: () => void) => this.testEmptySerialize(done),
      },
      {
        description: 'Should fail when headers are undefined',
        test: (done: () => void) => this.testUndefinedHeaders(done),
      },
      {
        description: 'Should continue when authenticate returns undefined',
        test: (done: () => void) => this.testSigningFails(done),
      },
    ];
  }

  private testSigV4Headers(done: () => void) {
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());

    exporter
      .export([], (result: ExportResult) => {
        expect(result.code).toBe(ExportResultCode.SUCCESS);
        expect(result.error?.message).toBe(undefined);
      })
      .then(() => {
        this.scope.on('request', (req, interceptor, body) => {
          this.assertHeaders(req.headers);
          expect(req.headers).not.toHaveProperty('content-encoding');
          done();
        });
      });
  }

  private testEnableCompression(done: () => void) {
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath(), {
      compression: CompressionAlgorithm.GZIP,
    });

    exporter
      .export([], (result: ExportResult) => {
        expect(result.code).toBe(ExportResultCode.SUCCESS);
        expect(result.error?.message).toBe(undefined);
      })
      .then(() => {
        this.scope.on('request', (req, interceptor, body) => {
          this.assertHeaders(req.headers);
          expect(req.headers['content-encoding']).toBe('gzip');

          //Gzip first 10 bytes are reserved for metadata headers:
          //https://www.loc.gov/preservation/digital/formats/fdd/fdd000599.shtml?loclr=blogsig
          const data = Buffer.from(body, 'hex');
          expect(data.length).toBeGreaterThanOrEqual(10);
          expect(data.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

          done();
        });
      });
  }

  private testSerializerAndGzipCalledOnce(done: () => void) {
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath(), {
      compression: CompressionAlgorithm.GZIP,
    });

    const serializeStub = this.sandbox
      .stub(exporter.parentSerializer, 'serializeRequest')
      .returns(new Uint8Array([1, 2, 3]));
    const gzipStub = this.sandbox.stub(require('zlib'), 'gzipSync').returns(new Uint8Array([0x1f, 0x8b, 1, 2, 3]));

    exporter
      .export([], (result: ExportResult) => {
        expect(result.code).toBe(ExportResultCode.SUCCESS);
        expect(serializeStub.callCount).toBe(1);
        expect(gzipStub.callCount).toBe(1);
      })
      .then(() => {
        this.scope.on('request', (req, interceptor, body) => {
          this.assertHeaders(req.headers);
          expect(req.headers['content-encoding']).toBe('gzip');
          done();
        });
      });
  }

  private testSigningFails(done: () => void) {
    this.sandbox.restore();
    this.sandbox = sinon.createSandbox();
    this.sandbox.stub(AwsAuthenticator.prototype, 'authenticate').resolves(undefined);

    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());

    exporter.export([], (result: ExportResult) => {
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(this.scope.isDone()).toBe(false);
      done();
    });
  }

  private testEmptySerialize(done: () => void) {
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());
    exporter.parentSerializer = {
      serializeRequest: this.sandbox.stub().returns(undefined),
      deserializeResponse: this.sandbox.stub(),
    };

    exporter.export([], (result: ExportResult) => {
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(result.error?.message).toBe('Nothing to send');
      expect(this.scope.isDone()).toBe(false);
      done();
    });
  }

  private testGzipException(done: () => void) {
    const gzipStub = this.sandbox.stub(require('zlib'), 'gzipSync').throws(new Error('Compression failed'));

    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath(), {
      compression: CompressionAlgorithm.GZIP,
    });

    exporter.export([], (result: ExportResult) => {
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(result.error?.message).toContain('Failed to compress');
      expect(this.scope.isDone()).toBe(false);
      gzipStub.restore();
      done();
    });
  }

  private testUndefinedHeaders(done: () => void) {
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());
    // OTel 2.x expects headers to be an async function - use resolves() instead of returns()
    exporter.parentExporter['_delegate']._transport._transport._parameters.headers = this.sandbox
      .stub()
      .resolves(undefined);

    exporter.export([], (result: ExportResult) => {
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(this.scope.isDone()).toBe(false);
      done();
    });
  }

  private assertHeaders(headers: Record<string, string>) {
    expect(headers).toHaveProperty(AUTHORIZATION_HEADER.toLowerCase());
    expect(headers).toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER.toLowerCase());
    expect(headers).toHaveProperty(X_AMZ_DATE_HEADER.toLowerCase());
    expect(headers).toHaveProperty(X_AMZ_CONTENT_SHA256_HEADER.toLowerCase());

    expect(headers[AUTHORIZATION_HEADER.toLowerCase()]).toBe(EXPECTED_AUTH_HEADER);
    expect(headers[X_AMZ_SECURITY_TOKEN_HEADER.toLowerCase()]).toBe(EXPECTED_X_AMZ_SECURITY_TOKEN);
    expect(headers[X_AMZ_CONTENT_SHA256_HEADER.toLowerCase()]).toBe(EXPECTED_X_AMZ_SHA_256);
    expect(headers[X_AMZ_DATE_HEADER.toLowerCase()]).toBe(EXPECTED_X_AMZ_DATE);

    expect(headers['content-type']).toBe('application/x-protobuf');
    expect(headers['user-agent']).toMatch(/^OTel-OTLP-Exporter-JavaScript\/\d+\.\d+\.\d+$/);
  }
}

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
        signedHash: req.headers[X_AMZ_CONTENT_SHA256_HEADER] as string | undefined,
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
          [AUTHORIZATION_HEADER]: `AWS4-HMAC-SHA256 payload=${payloadHash}`,
          [X_AMZ_DATE_HEADER]: '20260101T000000Z',
          [X_AMZ_CONTENT_SHA256_HEADER]: payloadHash,
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

  // The queue is released when an export produces a result, so a failed export must not hold it.
  // Nothing else covers that, and it is the guarantee that keeps a failure from wedging the exporter
  // permanently - which would be worse than the defect this fixes.
  it('should still run the next export when signing fails', async () => {
    // Replace the beforeEach stub: the first signing fails, later ones succeed.
    let call = 0;
    (AwsAuthenticator.prototype.authenticate as sinon.SinonStub).callsFake(async (headers: Record<string, string>) =>
      call++ === 0 ? undefined : { ...headers }
    );

    const server = await startServer();
    const spans = createSpans(2);

    try {
      const exporter = new OTLPAwsSpanExporter(server.url);

      const results = await Promise.all(
        [[spans[0]], [spans[1]]].map(
          batch => new Promise<ExportResult>(resolve => void exporter.export(batch, result => resolve(result)))
        )
      );

      expect(results.map(result => result.code)).toEqual([ExportResultCode.FAILED, ExportResultCode.SUCCESS]);
      // Only the second export reached the wire; the first failed before sending.
      expect(server.received).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  // Same guarantee for the other failure mode: an exception rather than a returned failure. These
  // take different paths out of the export - the catch in export() versus an early return in
  // doExport - and both must release the queue.
  it('should still run the next export when signing throws', async () => {
    let call = 0;
    (AwsAuthenticator.prototype.authenticate as sinon.SinonStub).callsFake(async (headers: Record<string, string>) => {
      if (call++ === 0) {
        throw new Error('credential resolution failed');
      }
      return { ...headers };
    });

    const server = await startServer();
    const spans = createSpans(2);

    try {
      const exporter = new OTLPAwsSpanExporter(server.url);

      const results = await Promise.all(
        [[spans[0]], [spans[1]]].map(
          batch => new Promise<ExportResult>(resolve => void exporter.export(batch, result => resolve(result)))
        )
      );

      expect(results.map(result => result.code)).toEqual([ExportResultCode.FAILED, ExportResultCode.SUCCESS]);
      expect(results[0].error?.message).toContain('credential resolution failed');
      expect(server.received).toHaveLength(1);
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
