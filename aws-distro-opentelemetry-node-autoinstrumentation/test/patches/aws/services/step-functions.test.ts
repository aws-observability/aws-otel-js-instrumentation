// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTestSpans, registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { applyInstrumentationPatches } from './../../../../src/patches/instrumentation-patch';

const instrumentations: AwsInstrumentation[] = [new AwsInstrumentation()];
applyInstrumentationPatches(instrumentations);
registerInstrumentationTesting(instrumentations[0]);

import { SFN } from '@aws-sdk/client-sfn';
import * as nock from 'nock';

import { SpanKind } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../../../src/aws-attribute-keys';

const region = 'us-east-1';

describe('SFN', () => {
  let sfn: SFN;
  beforeEach(() => {
    sfn = new SFN({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });

  describe('DescribeStateMachine', () => {
    it('span has stateMachineArn in its attributes', async () => {
      const stateMachineArn: string = 'arn:aws:states:us-east-1:123456789123:stateMachine:testStateMachine';

      nock(`https://states.${region}.amazonaws.com/`).post('/').reply(200, 'null');

      await sfn
        .describeStateMachine({
          stateMachineArn: stateMachineArn,
        })
        .catch((err: any) => {
          console.log(err);
        });

      const testSpans: ReadableSpan[] = getTestSpans();
      const getStateMachineAttributeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'SFN.DescribeStateMachine';
      });

      expect(getStateMachineAttributeSpans.length).toBe(1);

      const stateMachineAttributeSpan = getStateMachineAttributeSpans[0];

      expect(AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_STATEMACHINE_ARN in stateMachineAttributeSpan.attributes).toBe(true);
      expect(stateMachineAttributeSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_STATEMACHINE_ARN]).toBe(
        stateMachineArn
      );
      expect(stateMachineAttributeSpan.kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('DescribeActivity', () => {
    it('span has activityArn in its attributes', async () => {
      const activityArn: string = 'arn:aws:states:us-east-1:123456789123:activity:testActivity';

      nock(`https://states.${region}.amazonaws.com/`).post('/').reply(200, 'null');

      await sfn
        .describeActivity({
          activityArn: activityArn,
        })
        .catch((err: any) => {
          console.log(err);
        });

      const testSpans: ReadableSpan[] = getTestSpans();
      const getActivityAttributeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'SFN.DescribeActivity';
      });

      expect(getActivityAttributeSpans.length).toBe(1);

      const activityAttributeSpan = getActivityAttributeSpans[0];

      expect(AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_ACTIVITY_ARN in activityAttributeSpan.attributes).toBe(true);
      expect(activityAttributeSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_ACTIVITY_ARN]).toBe(activityArn);
      expect(activityAttributeSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});
