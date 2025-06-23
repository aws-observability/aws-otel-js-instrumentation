// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
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
        });
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
    exporter.parentExporter['_delegate']._transport._transport._parameters.headers = this.sandbox
      .stub()
      .returns(undefined);

    exporter.export([], (result: ExportResult) => {
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(result.error?.message).toContain('Request headers are undefined');
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
