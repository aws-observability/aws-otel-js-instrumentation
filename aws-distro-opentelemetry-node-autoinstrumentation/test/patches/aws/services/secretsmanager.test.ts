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
    it('no attribute generated in span if secretId is not an ARN', async () => {
      const secretId: string = "arn:aws:secretsmanager:sdsadsadtestId";

      nock(`https://secretsmanager.${region}.amazonaws.com/`).post('/').reply(200, 'null');

      await secretsManager.describeSecret({
            SecretId: secretId,
        }).catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const getDescribeSecretSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'SecretsManager.DescribeSecret';
      });
      expect(getDescribeSecretSpans.length).toBe(1);
      const getTopicAttributeSpan = getDescribeSecretSpans[0];
      expect(getTopicAttributeSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN]).toBe(secretId);
      expect(getTopicAttributeSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});
