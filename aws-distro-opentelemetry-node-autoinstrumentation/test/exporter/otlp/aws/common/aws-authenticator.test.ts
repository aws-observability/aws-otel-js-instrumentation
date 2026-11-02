// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach } from 'mocha';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';
import expect from 'expect';
import { diag } from '@opentelemetry/api';
import {
  AUTHORIZATION_HEADER,
  AwsAuthenticator,
  resolveSigV4Region,
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
        const stubs: { [key: string]: any } = {};
        stubs[dependency] = new Proxy(
          {},
          {
            get() {
              throw new Error(`Cannot find module '${dependency}'`);
            },
          }
        );

        const { AwsAuthenticator } = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', stubs);

        const result = await new AwsAuthenticator(
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

  // The strip list previously named x-amz-content-sha256 twice and omitted the security token, so a
  // stale token from a previous signing could survive into the next request. Credentials without a
  // session token do not get it overwritten by the signer, which is where it would have shown.
  it('should clear a stale security token when credentials carry no session token', async () => {
    const AwsAuthenticatorWithMock = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: sandbox.stub().resolves({
          accessKeyId: 'test_access_key',
          secretAccessKey: 'test_secret_key',
        }),
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock(
      'https://xray.us-east-1.amazonaws.com/v1/traces',
      'xray'
    ).authenticate({ [X_AMZ_SECURITY_TOKEN_HEADER]: 'stale_token_from_previous_export' }, new Uint8Array());

    if (version >= 16) {
      expect(result[X_AMZ_SECURITY_TOKEN_HEADER]).toBeUndefined();
    } else {
      expect(result).toBe(undefined);
    }
  });

  it('should sign China partition endpoints with the China region', async () => {
    const AwsAuthenticatorWithMock = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: sandbox.stub().resolves(mockCredentials),
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock(
      'https://xray.cn-north-1.amazonaws.com.cn/v1/traces',
      'xray'
    ).authenticate({ test: 'test' }, new Uint8Array());

    if (version >= 16) {
      // The credential scope proves the region was derived from the China hostname, which has an
      // extra label compared with a commercial endpoint.
      expect(result[AUTHORIZATION_HEADER]).toContain('/cn-north-1/xray/aws4_request');
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

  // The region lookup packages only serve the otlp/sigv4 fallback, so losing them must not stop the
  // existing AWS endpoint paths from signing.
  it('should still sign when the region lookup packages are unavailable', async () => {
    const missing = (name: string) =>
      new Proxy(
        {},
        {
          get() {
            throw new Error(`Cannot find module '${name}'`);
          },
        }
      );

    const AwsAuthenticatorWithMock = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: sandbox.stub().resolves(mockCredentials),
      },
      '@smithy/node-config-provider': missing('@smithy/node-config-provider'),
      '@smithy/config-resolver': missing('@smithy/config-resolver'),
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock(
      'https://xray.us-east-1.amazonaws.com/v1/traces',
      'xray'
    ).authenticate({ test: 'test' }, new Uint8Array());

    if (version >= 16) {
      expect(result[AUTHORIZATION_HEADER]).toContain('/us-east-1/xray/aws4_request');
    } else {
      expect(result).toBe(undefined);
    }
  });

  it('should sign with an explicit region instead of reading it from the endpoint', async () => {
    const AwsAuthenticatorWithMock = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: sandbox.stub().resolves(mockCredentials),
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock(
      'https://collector.example.com/v1/traces',
      'xray',
      'eu-west-1'
    ).authenticate({ test: 'test' }, new Uint8Array());

    if (version >= 16) {
      expect(result[AUTHORIZATION_HEADER]).toContain('/eu-west-1/xray/aws4_request');
    } else {
      expect(result).toBe(undefined);
    }
  });

  it('should look up the region when signing if given a region function', async () => {
    const AwsAuthenticatorWithMock = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: sandbox.stub().resolves(mockCredentials),
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock('https://collector.example.com/v1/logs', 'logs', () =>
      Promise.resolve('ap-southeast-2')
    ).authenticate({ test: 'test' }, new Uint8Array());

    if (version >= 16) {
      expect(result[AUTHORIZATION_HEADER]).toContain('/ap-southeast-2/logs/aws4_request');
    } else {
      expect(result).toBe(undefined);
    }
  });

  // SigV4 signs the Host header, so it must match the one actually sent, which includes a
  // non-default port.
  it('should sign the Host header including a non-default port', async () => {
    const AwsAuthenticatorWithMock = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: sandbox.stub().resolves(mockCredentials),
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock(
      'https://proxy.example.com:8443/v1/traces',
      'xray',
      'us-east-1'
    ).authenticate({ test: 'test' }, new Uint8Array());

    if (version >= 16) {
      expect(result.host).toBe('proxy.example.com:8443');
    } else {
      expect(result).toBe(undefined);
    }
  });

  // otlp/sigv4 replaces a configured bearer token rather than deferring to it. Header names are
  // case-insensitive, so a differently cased Authorization must not survive alongside the signature.
  it('should replace a configured bearer Authorization header regardless of case', async () => {
    const AwsAuthenticatorWithMock = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
      '@aws-sdk/credential-provider-node': {
        defaultProvider: sandbox.stub().resolves(mockCredentials),
      },
    }).AwsAuthenticator;

    const result = await new AwsAuthenticatorWithMock(
      'https://collector.example.com/v1/metrics',
      'monitoring',
      'us-east-1'
    ).authenticate({ Authorization: 'Bearer user-api-key' }, new Uint8Array());

    if (version >= 16) {
      const authorizationValues = Object.entries(result).filter(([key]) => key.toLowerCase() === 'authorization');
      expect(authorizationValues).toHaveLength(1);
      expect(authorizationValues[0][1]).toMatch(/^AWS4-HMAC-SHA256 /);
    } else {
      expect(result).toBe(undefined);
    }
  });

  describe('resolveSigV4Region', () => {
    const REGION_ENV_VARS = ['AWS_REGION', 'AWS_DEFAULT_REGION'];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const name of REGION_ENV_VARS) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    });

    afterEach(() => {
      for (const name of REGION_ENV_VARS) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    });

    it('prefers AWS_REGION, then AWS_DEFAULT_REGION, over the endpoint hostname', () => {
      const endpoint = 'https://xray.us-west-2.amazonaws.com/v1/traces';

      process.env.AWS_DEFAULT_REGION = 'eu-central-1';
      expect(resolveSigV4Region(endpoint)).toBe('eu-central-1');

      process.env.AWS_REGION = 'ap-northeast-1';
      expect(resolveSigV4Region(endpoint)).toBe('ap-northeast-1');
    });

    it('reads the region from AWS endpoint hostnames', () => {
      const cases: Array<[string, string]> = [
        ['https://xray.us-west-2.amazonaws.com/v1/traces', 'us-west-2'],
        ['https://MONITORING.US-EAST-1.AMAZONAWS.COM/v1/metrics', 'us-east-1'],
        ['https://logs.cn-north-1.amazonaws.com.cn/v1/logs', 'cn-north-1'],
        ['https://monitoring.us-gov-west-1.amazonaws.com/v1/metrics', 'us-gov-west-1'],
        // VPC endpoint and OSIS pipeline hostnames carry the region in a different position.
        ['https://vpce-0123456789abcdef-abcd1234.logs.us-west-2.vpce.amazonaws.com/v1/logs', 'us-west-2'],
        ['https://my-pipeline-abc123.us-east-1.osis.amazonaws.com/v1/logs', 'us-east-1'],
        ['https://xray.eu-west-1.api.aws/v1/traces', 'eu-west-1'],
      ];

      for (const [endpoint, region] of cases) {
        expect(resolveSigV4Region(endpoint)).toBe(region);
      }
    });

    it('returns undefined for hostnames outside AWS domains and unparseable endpoints', () => {
      for (const endpoint of [
        'http://localhost:4318/v1/traces',
        'https://collector.example.com/v1/traces',
        'https://xray.us-west-2.amazonaws.com.example.com/v1/traces',
        'https://xray.amazonaws.com/v1/traces',
        'not a url',
      ]) {
        expect(resolveSigV4Region(endpoint)).toBeUndefined();
      }
    });
  });

  describe('loadSigV4RegionFromAwsConfig', () => {
    const withLoadConfig = (provider: () => Promise<string | undefined>) => {
      const loadConfig = sandbox.stub().returns(provider);
      const module = proxyquire('../../../../../src/exporter/otlp/aws/common/aws-authenticator', {
        '@smithy/node-config-provider': { loadConfig },
      });
      return { loadConfig, lookup: module.loadSigV4RegionFromAwsConfig() };
    };

    it('resolves the region from the AWS config and looks it up only once', async () => {
      if (version < 16) {
        return;
      }

      const { loadConfig, lookup } = withLoadConfig(() => Promise.resolve('us-west-1'));

      expect(await lookup()).toBe('us-west-1');
      expect(await lookup()).toBe('us-west-1');
      expect(loadConfig.callCount).toBe(1);
    });

    it('fails with the settings that would fix it, logging the error once', async () => {
      if (version < 16) {
        return;
      }

      const errorSpy = sandbox.spy(diag, 'error');
      const { lookup } = withLoadConfig(() => Promise.reject(new Error('no region in the config file')));

      await expect(lookup()).rejects.toThrow('AWS_REGION');
      await expect(lookup()).rejects.toThrow('AWS_REGION');

      const regionErrors = errorSpy.getCalls().filter(call => String(call.args[0]).includes('signing region'));
      expect(regionErrors).toHaveLength(1);
    });
  });
});
