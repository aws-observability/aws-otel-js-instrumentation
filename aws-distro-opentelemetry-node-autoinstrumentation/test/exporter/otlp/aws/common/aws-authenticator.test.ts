// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach } from 'mocha';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';
import expect from 'expect';
import { AwsAuthenticator } from '../../../../../src/exporter/otlp/aws/common/aws-authenticator';
import {
  AUTHORIZATION_HEADER,
  AWS_AUTH_PATH,
  AWS_HTTP_MODULE,
  AWS_OTLP_TRACES_ENDPOINT,
  CREDENTIAL_PROVIDER_MODULE,
  SHA_256_MODULE,
  SIGNATURE_V4_MODULE,
  X_AMZ_DATE_HEADER,
  X_AMZ_SECURITY_TOKEN_HEADER,
} from './test-utils.test';
import { getNodeVersion } from '../../../../../src/utils';

const mockCredentials = {
  accessKeyId: 'test_access_key',
  secretAccessKey: 'test_secret_key',
  sessionToken: 'test_session_token',
};

// Sigv4 is only enabled for node version >= 16
const version = getNodeVersion();

describe('AwsAuthenticator', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('should not inject SigV4 Headers if required modules are not available', async () => {
    const dependencies = [SIGNATURE_V4_MODULE, CREDENTIAL_PROVIDER_MODULE, SHA_256_MODULE, AWS_HTTP_MODULE];

    dependencies.forEach(dependency => {
      it(`should not sign headers if missing dependency: ${dependency}`, async () => {
        Object.keys(require.cache).forEach(key => {
          delete require.cache[key];
        });

        const requireStub = sandbox.stub(require('module'), '_load');
        requireStub.withArgs(dependency).throws(new Error(`Cannot find module '${dependency}'`));
        requireStub.callThrough();

        const { AwsAuthenticator: MockThrowableModuleAuthenticator } = require(AWS_AUTH_PATH);

        const result = await new MockThrowableModuleAuthenticator('us-east-1', 'xray').authenticate(
          AWS_OTLP_TRACES_ENDPOINT,
          {},
          new Uint8Array()
        );

        expect(result).not.toHaveProperty(AUTHORIZATION_HEADER);
        expect(result).not.toHaveProperty(X_AMZ_DATE_HEADER);
        expect(result).not.toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);
      });
    });
  });

  it('should not inject SigV4 Headers if serialized data is undefined', async () => {
    const authenticator = new AwsAuthenticator('us-east-1', 'xray');
    const result = await authenticator.authenticate(AWS_OTLP_TRACES_ENDPOINT, {}, undefined);

    expect(result).not.toHaveProperty(AUTHORIZATION_HEADER);
    expect(result).not.toHaveProperty(X_AMZ_DATE_HEADER);
    expect(result).not.toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);
  });

  it('should inject SigV4 Headers', async () => {
    const expected = {
      [AUTHORIZATION_HEADER]: 'testAuth',
      [X_AMZ_DATE_HEADER]: 'testDate',
      [X_AMZ_SECURITY_TOKEN_HEADER]: 'testSecurityToken',
    };

    const AwsAuthenticatorWithMock = proxyquire(AWS_AUTH_PATH, {
      [CREDENTIAL_PROVIDER_MODULE]: {
        defaultProvider: () => Promise.resolve(mockCredentials),
      },
      [SIGNATURE_V4_MODULE]: {
        SignatureV4: class {
          constructor() {}
          sign(request: any) {
            return Promise.resolve({
              headers: expected,
            });
          }
        },
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock('us-east-1', 'xray').authenticate(
      AWS_OTLP_TRACES_ENDPOINT,
      { test: 'test' },
      new Uint8Array()
    );

    if (version >= 16) {
      expect(result).toHaveProperty(AUTHORIZATION_HEADER);
      expect(result).toHaveProperty(X_AMZ_DATE_HEADER);
      expect(result).toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);

      expect(result[AUTHORIZATION_HEADER]).toBe(expected[AUTHORIZATION_HEADER]);
      expect(result[X_AMZ_DATE_HEADER]).toBe(expected[X_AMZ_DATE_HEADER]);
      expect(result[X_AMZ_SECURITY_TOKEN_HEADER]).toBe(expected[X_AMZ_SECURITY_TOKEN_HEADER]);
    } else {
      expect(result).not.toHaveProperty(AUTHORIZATION_HEADER);
      expect(result).not.toHaveProperty(X_AMZ_DATE_HEADER);
      expect(result).not.toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);
    }
  });

  it('should clear SigV4 headers if already present ', async () => {
    const notExpected = {
      [AUTHORIZATION_HEADER]: 'notExpectedAuth',
      [X_AMZ_DATE_HEADER]: 'notExpectedDate',
      [X_AMZ_SECURITY_TOKEN_HEADER]: 'notExpectedSecurityToken',
    };

    const expected = {
      [AUTHORIZATION_HEADER]: 'testAuth',
      [X_AMZ_DATE_HEADER]: 'testDate',
      [X_AMZ_SECURITY_TOKEN_HEADER]: 'testSecurityToken',
    };

    const AwsAuthenticatorWithMock = proxyquire(AWS_AUTH_PATH, {
      [CREDENTIAL_PROVIDER_MODULE]: {
        defaultProvider: () => Promise.resolve(mockCredentials),
      },
      [SIGNATURE_V4_MODULE]: {
        SignatureV4: class {
          constructor() {}
          sign(request: any) {
            return Promise.resolve({
              headers: expected,
            });
          }
        },
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock('us-east-1', 'xray').authenticate(
      AWS_OTLP_TRACES_ENDPOINT,
      notExpected,
      new Uint8Array()
    );
    expect(result).toHaveProperty(AUTHORIZATION_HEADER);
    expect(result).toHaveProperty(X_AMZ_DATE_HEADER);
    expect(result).toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);

    if (version >= 16) {
      expect(result[AUTHORIZATION_HEADER]).toBe(expected[AUTHORIZATION_HEADER]);
      expect(result[X_AMZ_DATE_HEADER]).toBe(expected[X_AMZ_DATE_HEADER]);
      expect(result[X_AMZ_SECURITY_TOKEN_HEADER]).toBe(expected[X_AMZ_SECURITY_TOKEN_HEADER]);
    } else {
      expect(result[AUTHORIZATION_HEADER]).toBe(notExpected[AUTHORIZATION_HEADER]);
      expect(result[X_AMZ_DATE_HEADER]).toBe(notExpected[X_AMZ_DATE_HEADER]);
      expect(result[X_AMZ_SECURITY_TOKEN_HEADER]).toBe(notExpected[X_AMZ_SECURITY_TOKEN_HEADER]);
    }
  });
});
