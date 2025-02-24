// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import expect from 'expect';
import { OTLPAwsSpanExporter } from '../src/otlp-aws-span-exporter';
import * as sinon from 'sinon';
import * as proxyquire from 'proxyquire';
import nock = require('nock');

const XRAY_OTLP_ENDPOINT = 'https://xray.us-east-1.amazonaws.com';
const AUTHORIZATION_HEADER = 'Authorization';
const X_AMZ_DATE_HEADER = 'X-Amz-Date';
const X_AMZ_SECURITY_TOKEN_HEADER = 'X-Amz-Security-Token';

const EXPECTED_AUTH_HEADER = 'AWS4-HMAC-SHA256 Credential=test_key/some_date/us-east-1/xray/aws4_request';
const EXPECTED_AUTH_X_AMZ_DATE = 'some_date';
const EXPECTED_AUTH_SECURITY_TOKEN = 'test_token';

describe('OTLPAwsSpanExporter', () => {
  let sandbox: sinon.SinonSandbox;
  let scope: nock.Scope;
  let mockModule: any;

  beforeEach(() => {
    scope = nock(XRAY_OTLP_ENDPOINT)
      .post('/v1/traces')
      .reply((uri: any, requestBody: any) => {
        return [200, ''];
      });

    sandbox = sinon.createSandbox();
    mockModule = proxyquire('../src/otlp-aws-span-exporter', {
      '@smithy/signature-v4': {
        SignatureV4: class MockSignatureV4 {
          sign(req: any) {
            req.headers = {
              ...req.headers,
              [AUTHORIZATION_HEADER]: EXPECTED_AUTH_HEADER,
              [X_AMZ_DATE_HEADER]: EXPECTED_AUTH_X_AMZ_DATE,
              [X_AMZ_SECURITY_TOKEN_HEADER]: EXPECTED_AUTH_SECURITY_TOKEN,
            };

            return req;
          }
        },
      },
      '@aws-sdk/credential-provider-node': {
        defaultProvider: () => async () => {
          return {
            accessKeyId: 'test_access_key',
            secretAccessKey: 'test_secret_key',
          };
        },
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('Should inject SigV4 Headers successfully', () => {
    const exporter = new mockModule.OTLPAwsSpanExporter(XRAY_OTLP_ENDPOINT + '/v1/traces');

    scope.on('request', (req, interceptor, body) => {
      const headers = req.headers;
      expect(headers).toHaveProperty(AUTHORIZATION_HEADER.toLowerCase());
      expect(headers).toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER.toLowerCase());
      expect(headers).toHaveProperty(X_AMZ_DATE_HEADER.toLowerCase());

      expect(headers[AUTHORIZATION_HEADER.toLowerCase()]).toBe(EXPECTED_AUTH_HEADER);
      expect(headers[X_AMZ_SECURITY_TOKEN_HEADER.toLowerCase()]).toBe(EXPECTED_AUTH_SECURITY_TOKEN);
      expect(headers[X_AMZ_DATE_HEADER.toLowerCase()]).toBe(EXPECTED_AUTH_X_AMZ_DATE);

      expect(headers['content-type']).toBe('application/x-protobuf');
      expect(headers['user-agent']).toMatch(/^OTel-OTLP-Exporter-JavaScript\/\d+\.\d+\.\d+$/);
    });

    exporter.export([], () => {});
  });
  
  describe('Should not inject SigV4 headers if dependencies are missing', () => {
    const dependencies = [
      '@aws-sdk/credential-provider-node',
      '@aws-crypto/sha256-js',
      '@smithy/signature-v4',
      '@smithy/protocol-http',
    ];

    dependencies.forEach(dependency => {
      it(`should not sign headers if missing dependency: ${dependency}`, () => {
        const exporter = new OTLPAwsSpanExporter(XRAY_OTLP_ENDPOINT + '/v1/traces');

        scope.on('request', (req, interceptor, body) => {
          const headers = req.headers;
          expect(headers).not.toHaveProperty(AUTHORIZATION_HEADER);
          expect(headers).not.toHaveProperty(X_AMZ_DATE_HEADER);
          expect(headers).not.toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);

          expect(headers['content-type']).toBe('application/x-protobuf');
          expect(headers['user-agent']).toMatch(/^OTel-OTLP-Exporter-JavaScript\/\d+\.\d+\.\d+$/);
        });

        Object.keys(require.cache).forEach(key => {
          delete require.cache[key];
        });
        const requireStub = sandbox.stub(require('module'), '_load');
        requireStub.withArgs(dependency).throws(new Error(`Cannot find module '${dependency}'`));
        requireStub.callThrough();

        exporter.export([], () => {});
      });
    });
  });

  it('should not inject SigV4 headers if failure to sign headers', async () => {
    scope.on('request', (req, interceptor, body) => {
      const headers = req.headers;
      expect(headers).not.toHaveProperty(AUTHORIZATION_HEADER);
      expect(headers).not.toHaveProperty(X_AMZ_DATE_HEADER);
      expect(headers).not.toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);

      expect(headers['content-type']).toBe('application/x-protobuf');
      expect(headers['user-agent']).toMatch(/^OTel-OTLP-Exporter-JavaScript\/\d+\.\d+\.\d+$/);
    });

    const stubbedModule = proxyquire('../src/otlp-aws-span-exporter', {
      '@smithy/signature-v4': {
        SignatureV4: class MockSignatureV4 {
          sign() {
            throw new Error('signing error');
          }
        },
      },
    });

    const exporter = new stubbedModule.OTLPAwsSpanExporter(XRAY_OTLP_ENDPOINT);

    exporter.export([], () => {});
  });

  it('should not inject SigV4 headers if failure to retrieve credentials', async () => {
    scope.on('request', (req, interceptor, body) => {
      const headers = req.headers;
      expect(headers).not.toHaveProperty(AUTHORIZATION_HEADER);
      expect(headers).not.toHaveProperty(X_AMZ_DATE_HEADER);
      expect(headers).not.toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);

      expect(headers['content-type']).toBe('application/x-protobuf');
      expect(headers['user-agent']).toMatch(/^OTel-OTLP-Exporter-JavaScript\/\d+\.\d+\.\d+$/);
    });

    const stubbedModule = proxyquire('../src/otlp-aws-span-exporter', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: () => async () => {
          throw new Error('credentials error');
        },
      },
    });

    const exporter = new stubbedModule.OTLPAwsSpanExporter(XRAY_OTLP_ENDPOINT);

    exporter.export([], () => {});
  });
});
