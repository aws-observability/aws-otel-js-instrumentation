// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTestSpans, registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { applyInstrumentationPatches } from './../../../../src/patches/instrumentation-patch';

const instrumentations: AwsInstrumentation[] = [new AwsInstrumentation()];
applyInstrumentationPatches(instrumentations);
registerInstrumentationTesting(instrumentations[0]);

import { SNS } from '@aws-sdk/client-sns';
import * as nock from 'nock';

import { SpanKind } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../../../src/aws-attribute-keys';

const region = 'us-east-1';

describe('SNS', () => {
  let sns: SNS;
  beforeEach(() => {
    sns = new SNS({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });
  describe('GetTopicAttributes', () => {
    it('span has sns topic.arn in its attributes', async () => {
      const topicArn: string = "arn:aws:sns:us-east-1:123456789012:mystack-mytopic-NZJ5JSMVGFIE";

      nock(`https://sns.${region}.amazonaws.com/`).post('/').reply(200, 'null');

      await sns.getTopicAttributes({
            TopicArn: topicArn,
        }).catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const getTopicAttributeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'SNS.GetTopicAttributes';
      });
      expect(getTopicAttributeSpans.length).toBe(1);
      const getTopicAttributeSpan = getTopicAttributeSpans[0];
      expect(getTopicAttributeSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_SNS_TOPIC_ARN]).toBe(topicArn);
      expect(getTopicAttributeSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});
