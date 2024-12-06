// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTestSpans, registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { applyInstrumentationPatches } from './../../../../src/patches/instrumentation-patch';

const instrumentations: AwsInstrumentation[] = [new AwsInstrumentation()];
applyInstrumentationPatches(instrumentations);
registerInstrumentationTesting(instrumentations[0]);

import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import * as nock from 'nock';

import { SpanKind } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../../../src/aws-attribute-keys';

const region = 'us-east-1';

describe('SecretsManager', () => {
  let secretsManager: SecretsManager;
  beforeEach(() => {
    secretsManager = new SecretsManager({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });

  describe('DescribeSecret', () => {
    const testParams = [
      'testId',
      'badarn:aws:secretsmanager:us-weast-1:123456789123:secret:testId123456',
      'arn:aws:secretsmanager:us-east-1:123456789123:secret:testId123456',
    ];

    testParams.forEach(secretId => {
      it('should generate secret arn attribute only if secretId is an valid ARN', async () => {
        nock(`https://secretsmanager.${region}.amazonaws.com/`).post('/').reply(200, 'null');

        await secretsManager
          .describeSecret({
            SecretId: secretId,
          })
          .catch((err: any) => {});

        const testSpans: ReadableSpan[] = getTestSpans();
        const getDescribeSecretSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
          return s.name === 'SecretsManager.DescribeSecret';
        });

        expect(getDescribeSecretSpans.length).toBe(1);
        const describeSecretSpan = getDescribeSecretSpans[0];

        if (secretId.startsWith('arn:aws:secretsmanager:')) {
          expect(describeSecretSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN]).toBe(secretId);
        } else {
          expect(describeSecretSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN]).toBeUndefined();
        }

        expect(describeSecretSpan.kind).toBe(SpanKind.CLIENT);
      });
    });
  });

  describe('GetSecretValue', () => {
    it('secret arn attribute should be populated from the response', async () => {
      const secretIdArn = 'arn:aws:secretsmanager:us-east-1:123456789123:secret:testId123456';

      nock(`https://secretsmanager.${region}.amazonaws.com/`).post('/').reply(200, {
        ARN: secretIdArn,
        Name: 'testId',
      });

      await secretsManager
        .getSecretValue({
          SecretId: 'testSecret',
        })
        .catch((err: any) => {
          console.log(err);
        });

      const testSpans: ReadableSpan[] = getTestSpans();
      const getSecretValueSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'SecretsManager.GetSecretValue';
      });

      expect(getSecretValueSpans.length).toBe(1);

      const secretValueSpan = getSecretValueSpans[0];

      expect(secretValueSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN]).toBe(secretIdArn);
      expect(secretValueSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});
