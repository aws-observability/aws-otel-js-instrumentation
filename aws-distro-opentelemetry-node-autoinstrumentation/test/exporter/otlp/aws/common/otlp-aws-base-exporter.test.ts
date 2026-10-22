// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { createHash } from 'crypto';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import * as sinon from 'sinon';
import * as nock from 'nock';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import {
  AUTHORIZATION_HEADER,
  AwsAuthenticator,
  X_AMZ_CONTENT_SHA256_HEADER,
  X_AMZ_DATE_HEADER,
  X_AMZ_SECURITY_TOKEN_HEADER,
} from '../../../../../src/exporter/otlp/aws/common/aws-authenticator';

const EXPECTED_AUTH_HEADER = 'AWS4-HMAC-SHA256 Credential=test_key/some_date/us-east-1/logs/aws4_request';
const EXPECTED_X_AMZ_DATE = 'some_date';
const EXPECTED_X_AMZ_SECURITY_TOKEN = 'test_token';
const EXPECTED_X_AMZ_SHA_256 = 'test_sha256';

export abstract class OTLPAwsBaseExporterTest<Payload> {
  protected sandbox!: sinon.SinonSandbox;
  protected scope!: nock.Scope;
  private requestInterceptor!: nock.Interceptor;
  private unmatchedRequests: string[] = [];
  private readonly recordUnmatchedRequest = (req: { method?: string; path?: string }) => {
    this.unmatchedRequests.push(`${req.method} ${req.path}`);
  };

  protected abstract getEndpoint(): string;
  protected abstract getEndpointPath(): string;
  protected abstract getExporter(): any;

  /**
   * Builds the payload handed to export(), holding one real SDK record per name. This works at the
   * payload level rather than per record because signals differ in shape: traces and logs export an
   * array of records, whereas metrics export a single ResourceMetrics object.
   */
  protected abstract createPayload(names: string[]): Payload;

  public beforeEach() {
    this.sandbox = sinon.createSandbox();

    this.requestInterceptor = nock(this.getEndpoint()).post(this.getEndpointPath());
    this.scope = this.requestInterceptor.reply(200, '');
    this.unmatchedRequests = [];
    nock.emitter.on('no match', this.recordUnmatchedRequest);

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
    nock.emitter.removeListener('no match', this.recordUnmatchedRequest);
    nock.cleanAll();
  }

  public testCommon(): Array<{ description: string; test: (done: Mocha.Done) => void }> {
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
      {
        description: 'Should sign for the configured service and region',
        test: (done: Mocha.Done) => {
          void this.testSignsWithConfiguredServiceAndRegion().then(() => done(), done);
        },
      },
      {
        description: 'Should not mix bodies or signatures when two exports overlap',
        test: done => {
          void this.testExportWithConcurrentBatchesDeliversEachBatchOnce([['first'], ['second']]).then(
            () => done(),
            done
          );
        },
      },
      {
        description: 'Should deliver every batch once when three batches export concurrently',
        test: done => {
          const names = Array.from({ length: 30 }, (_, index) => `item-${index}`);
          void this.testExportWithConcurrentBatchesDeliversEachBatchOnce([
            names.slice(0, 10),
            names.slice(10, 20),
            names.slice(20),
          ]).then(() => done(), done);
        },
      },
      {
        description: 'Should deliver every batch once when exports do not overlap',
        test: done => {
          void this.testExportWithSequentialBatchesDeliversEachBatchOnce([['first'], ['second'], ['third']]).then(
            () => done(),
            done
          );
        },
      },
      {
        description: 'Should still run the next export when signing returns undefined',
        test: done => {
          void this.testExportWhenSigningReturnsUndefinedContinuesWithNextBatch([['failed'], ['next']]).then(
            () => done(),
            done
          );
        },
      },
      {
        description: 'Should still run the next export when signing throws',
        test: done => {
          void this.testExportWhenSigningThrowsContinuesWithNextBatch([['failed'], ['next']]).then(() => done(), done);
        },
      },
      {
        description: 'Should finish queued exports before forceFlush resolves',
        test: done => {
          void this.testForceFlushWithQueuedExportsWaitsForCompletion([['first'], ['second']]).then(() => done(), done);
        },
      },
    ];
  }

  private testSigV4Headers(done: () => void) {
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());

    exporter
      .export(this.createPayload([]), (result: ExportResult) => {
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
      .export(this.createPayload([]), (result: ExportResult) => {
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
      .export(this.createPayload([]), (result: ExportResult) => {
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

  // otlp/sigv4 passes an explicit service and region, because its endpoint need not be a standard
  // AWS endpoint that the signer could read them from.
  private async testSignsWithConfiguredServiceAndRegion() {
    const signedFor: Array<{ service: string; region: unknown }> = [];
    (AwsAuthenticator.prototype.authenticate as sinon.SinonStub).callsFake(function (
      this: any,
      headers: Record<string, string>
    ) {
      signedFor.push({ service: this.service, region: this.region });
      return Promise.resolve({ ...headers, [AUTHORIZATION_HEADER]: EXPECTED_AUTH_HEADER });
    });

    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath(), undefined, {
      service: 'custom-service',
      region: 'eu-west-1',
    });

    const result = await new Promise<ExportResult>(resolve => void exporter.export(this.createPayload([]), resolve));

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(signedFor).toEqual([{ service: 'custom-service', region: 'eu-west-1' }]);
    this.assertOnlyExpectedRequestsSent();
  }

  private testSigningFails(done: () => void) {
    this.sandbox.restore();
    this.sandbox = sinon.createSandbox();
    this.sandbox.stub(AwsAuthenticator.prototype, 'authenticate').resolves(undefined);

    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());

    exporter.export(this.createPayload([]), (result: ExportResult) => {
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

    exporter.export(this.createPayload([]), (result: ExportResult) => {
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

    exporter.export(this.createPayload([]), (result: ExportResult) => {
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

    exporter.export(this.createPayload([]), (result: ExportResult) => {
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(this.scope.isDone()).toBe(false);
      done();
    });
  }

  // The scenarios below cover a concurrency defect in OTLPAwsBaseExporter. Exports overlap whenever a
  // batch processor flushes, because BatchSpanProcessorBase._flushAll() exports every queued batch in
  // parallel on forceFlush() and shutdown(). Per-request state used to live on objects shared by every
  // export, so overlapping exports could send one batch's body with another batch's signature, or send
  // one batch twice and drop another. Exports are now queued, and the queue must be released when an
  // export fails, since a queue that stays held would block every later export.

  private async testExportWithConcurrentBatchesDeliversEachBatchOnce(batchNames: string[][]) {
    const batches = batchNames.map(names => this.createPayload(names));
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());
    this.assertSignedBatches(exporter, batches);

    const results = await Promise.all(
      batches.map(batch => new Promise<ExportResult>(resolve => void exporter.export(batch, resolve)))
    );

    expect(results.map(result => result.code)).toEqual(batches.map(() => ExportResultCode.SUCCESS));
    this.assertOnlyExpectedRequestsSent();
  }

  private async testExportWithSequentialBatchesDeliversEachBatchOnce(batchNames: string[][]) {
    const batches = batchNames.map(names => this.createPayload(names));
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());
    this.assertSignedBatches(exporter, batches);

    for (const batch of batches) {
      const result = await new Promise<ExportResult>(resolve => void exporter.export(batch, resolve));
      expect(result.code).toBe(ExportResultCode.SUCCESS);
    }

    this.assertOnlyExpectedRequestsSent();
  }

  private async testExportWhenSigningReturnsUndefinedContinuesWithNextBatch(batchNames: string[][]) {
    const batches = batchNames.map(names => this.createPayload(names));
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());
    this.assertSignedBatches(exporter, batches.slice(1));
    (AwsAuthenticator.prototype.authenticate as sinon.SinonStub).onFirstCall().resolves(undefined);

    const results = await Promise.all(
      batches.map(batch => new Promise<ExportResult>(resolve => void exporter.export(batch, resolve)))
    );

    expect(results.map(result => result.code)).toEqual([ExportResultCode.FAILED, ExportResultCode.SUCCESS]);
    this.assertOnlyExpectedRequestsSent();
  }

  private async testExportWhenSigningThrowsContinuesWithNextBatch(batchNames: string[][]) {
    const batches = batchNames.map(names => this.createPayload(names));
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());
    this.assertSignedBatches(exporter, batches.slice(1));
    (AwsAuthenticator.prototype.authenticate as sinon.SinonStub)
      .onFirstCall()
      .rejects(new Error('credential resolution failed'));

    const results = await Promise.all(
      batches.map(batch => new Promise<ExportResult>(resolve => void exporter.export(batch, resolve)))
    );

    expect(results.map(result => result.code)).toEqual([ExportResultCode.FAILED, ExportResultCode.SUCCESS]);
    expect(results[0].error?.message).toContain('credential resolution failed');
    this.assertOnlyExpectedRequestsSent();
  }

  private async testForceFlushWithQueuedExportsWaitsForCompletion(batchNames: string[][]) {
    const batches = batchNames.map(names => this.createPayload(names));
    const exporterClass = this.getExporter();
    const exporter = new exporterClass(this.getEndpoint() + this.getEndpointPath());
    this.assertSignedBatches(exporter, batches);
    const completed = this.sandbox.spy();

    batches.forEach(batch => void exporter.export(batch, completed));
    await exporter.forceFlush();

    expect(completed.callCount).toBe(batches.length);
    expect(completed.args.map(([result]) => result.code)).toEqual(batches.map(() => ExportResultCode.SUCCESS));
    this.assertOnlyExpectedRequestsSent();
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

  /**
   * Asserts that every expected request was sent exactly once and that nothing else was sent. Nock
   * would otherwise only fail the export that made an unexpected request, which goes unnoticed when
   * that export was expected to fail anyway, such as a batch whose signing failed.
   */
  private assertOnlyExpectedRequestsSent() {
    this.scope.done();
    expect(this.unmatchedRequests).toEqual([]);
  }

  private assertSignedBatches(exporter: any, batches: Payload[]) {
    // Replace the default catch-all request with one exact expectation per batch.
    nock.removeInterceptor(this.requestInterceptor);
    const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

    (AwsAuthenticator.prototype.authenticate as sinon.SinonStub).callsFake(
      async (headers: Record<string, string>, serializedData: Uint8Array | undefined) => {
        await Promise.resolve();
        return {
          ...headers,
          [AUTHORIZATION_HEADER]: EXPECTED_AUTH_HEADER,
          [X_AMZ_DATE_HEADER]: EXPECTED_X_AMZ_DATE,
          [X_AMZ_SECURITY_TOKEN_HEADER]: EXPECTED_X_AMZ_SECURITY_TOKEN,
          [X_AMZ_CONTENT_SHA256_HEADER]: hash(serializedData!),
        };
      }
    );

    for (const batch of batches) {
      const body = Buffer.from(exporter.parentSerializer.serializeRequest(batch));
      this.scope.post(this.getEndpointPath(), body).matchHeader(X_AMZ_CONTENT_SHA256_HEADER, hash(body)).reply(200, '');
    }
  }
}
