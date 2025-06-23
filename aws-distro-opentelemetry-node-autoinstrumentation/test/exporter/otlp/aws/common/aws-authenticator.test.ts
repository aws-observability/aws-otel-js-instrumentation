// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach } from 'mocha';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';
import expect from 'expect';
import {
  AUTHORIZATION_HEADER,
  AwsAuthenticator,
  X_AMZ_CONTENT_SHA256_HEADER,
  X_AMZ_DATE_HEADER,
  X_AMZ_SECURITY_TOKEN_HEADER,
} from '../../../../../src/exporter/otlp/aws/common/aws-authenticator';
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
    const dependencies = [
      '@smithy/signature-v4',
      '@aws-sdk/credential-provider-node',
      '@aws-crypto/sha256-js',
      '@smithy/protocol-http',
    ];

    dependencies.forEach(dependency => {
      it(`should not sign headers if missing dependency: ${dependency}`, async () => {
        Object.keys(require.cache).forEach(key => {
          delete require.cache[key];
        });

        const requireStub = sandbox.stub(require('module'), '_load');
        requireStub.withArgs(dependency).throws(new Error(`Cannot find module '${dependency}'`));
        requireStub.callThrough();

        const {
          AwsAuthenticator: MockThrowableModuleAuthenticator,
        } = require('../../../../../src/exporter/otlp/aws/common/aws-authenticator');

        const result = await new MockThrowableModuleAuthenticator(
          'https://xray.us-east-1.amazonaws.com/v1/traces',
          'xray'
        ).authenticate({}, new Uint8Array());

        expect(result).toBe(undefined);
      });
    });
  });

  it('should not inject SigV4 Headers if serialized data is undefined', async () => {
    const authenticator = new AwsAuthenticator('https://xray.us-east-1.amazonaws.com/v1/traces', 'xray');
    const result = await authenticator.authenticate({}, undefined);

    expect(result).toBe(undefined);
  });

  it('should inject SigV4 Headers', async () => {
    const AwsAuthenticatorWithMock = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: sandbox.stub().resolves(mockCredentials),
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock(
      'https://xray.us-east-1.amazonaws.com/v1/traces',
      'xray'
    ).authenticate({ test: 'test' }, new Uint8Array());

    if (version >= 16) {
      expect(result).toHaveProperty(AUTHORIZATION_HEADER);
      expect(result).toHaveProperty(X_AMZ_DATE_HEADER);
      expect(result).toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);
      expect(result).toHaveProperty(X_AMZ_CONTENT_SHA256_HEADER);
    } else {
      expect(result).toBe(undefined);
    }
  });

  it('should clear SigV4 headers if already present ', async () => {
    const oldHeaders = {
      [AUTHORIZATION_HEADER]: 'notExpectedAuth',
      [X_AMZ_DATE_HEADER]: 'notExpectedDate',
      [X_AMZ_SECURITY_TOKEN_HEADER]: 'notExpectedSecurityToken',
      [X_AMZ_CONTENT_SHA256_HEADER]: 'notExpectedSha256Content',
    };

    const AwsAuthenticatorWithMock = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: sandbox.stub().resolves(mockCredentials),
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock(
      'https://xray.us-east-1.amazonaws.com/v1/traces',
      'xray'
    ).authenticate(oldHeaders, new Uint8Array());

    if (version >= 16) {
      expect(result).toHaveProperty(AUTHORIZATION_HEADER);
      expect(result).toHaveProperty(X_AMZ_DATE_HEADER);
      expect(result).toHaveProperty(X_AMZ_SECURITY_TOKEN_HEADER);
      expect(result).toHaveProperty(X_AMZ_CONTENT_SHA256_HEADER);
      expect(result[AUTHORIZATION_HEADER]).not.toBe(oldHeaders[AUTHORIZATION_HEADER]);
      expect(result[X_AMZ_DATE_HEADER]).not.toBe(oldHeaders[X_AMZ_DATE_HEADER]);
      expect(result[X_AMZ_SECURITY_TOKEN_HEADER]).not.toBe(oldHeaders[X_AMZ_SECURITY_TOKEN_HEADER]);
      expect(result[X_AMZ_CONTENT_SHA256_HEADER]).not.toBe(oldHeaders[X_AMZ_CONTENT_SHA256_HEADER]);
    } else {
      expect(result).toBe(undefined);
    }
  });
});
