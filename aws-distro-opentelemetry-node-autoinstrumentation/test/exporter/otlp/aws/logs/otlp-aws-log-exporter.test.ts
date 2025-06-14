// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  AWS_OTLP_LOGS_ENDPOINT,
  AWS_OTLP_LOGS_ENDPOINT_PATH,
  AUTHORIZATION_HEADER,
  X_AMZ_DATE_HEADER,
  X_AMZ_SECURITY_TOKEN_HEADER,
  AWS_LOG_EXPORTER_PATH,
} from '../common/test-utils.test';
import * as sinon from 'sinon';
import * as proxyquire from 'proxyquire';
import * as nock from 'nock';

const EXPECTED_AUTH_HEADER = 'AWS4-HMAC-SHA256 Credential=test_key/some_date/us-east-1/logs/aws4_request';
const EXPECTED_AUTH_X_AMZ_DATE = 'some_date';
const EXPECTED_AUTH_SECURITY_TOKEN = 'test_token';

describe('OTLPAwsLogExporter', () => {
  let sandbox: sinon.SinonSandbox;
  let scope: nock.Scope;
  let mockModule: any;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    scope = nock(AWS_OTLP_LOGS_ENDPOINT)
      .post(AWS_OTLP_LOGS_ENDPOINT_PATH)
      .reply((uri: any, requestBody: any) => {
        return [200, ''];
      });

    mockModule = proxyquire(AWS_LOG_EXPORTER_PATH, {
      '../common/aws-authenticator': {
        AwsAuthenticator: class MockAwsAuthenticator {
          constructor() {}
          async authenticate(endpoint: string, headers: Record<string, string>) {
            return {
              ...headers,
              [AUTHORIZATION_HEADER]: EXPECTED_AUTH_HEADER,
              [X_AMZ_DATE_HEADER]: EXPECTED_AUTH_X_AMZ_DATE,
              [X_AMZ_SECURITY_TOKEN_HEADER]: EXPECTED_AUTH_SECURITY_TOKEN,
            };
          }
        },
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('Should inject SigV4 Headers successfully', done => {
    const exporter = new mockModule.OTLPAwsLogExporter(AWS_OTLP_LOGS_ENDPOINT + AWS_OTLP_LOGS_ENDPOINT_PATH);

    exporter
      .export([], () => {})
      .then(() => {
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
          done();
        });
      });
  });
});
