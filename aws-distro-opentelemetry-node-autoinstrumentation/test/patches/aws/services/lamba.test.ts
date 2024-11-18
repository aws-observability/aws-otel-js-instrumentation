// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTestSpans, registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { applyInstrumentationPatches } from './../../../../src/patches/instrumentation-patch';

const instrumentations: AwsInstrumentation[] = [new AwsInstrumentation()];
applyInstrumentationPatches(instrumentations);
registerInstrumentationTesting(instrumentations[0]);

import { Lambda } from '@aws-sdk/client-lambda';
import * as nock from 'nock';

import { SpanKind } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../../../src/aws-attribute-keys';

const region = 'us-east-1';

describe('Lambda', () => {
  let lambda: Lambda;
  beforeEach(() => {
    lambda = new Lambda({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });

  describe('GetFunction', () => {
    {
      it('span has lambda functionName and function ARN in its attributes', async () => {
        const funcName = 'testFunction';
        const arn = 'arn:aws:lambda:us-east-1:123456789012:function:testFunction';

        nock(`https://lambda.${region}.amazonaws.com/`)
          .get(/.*/)
          .reply(200, {
            Configuration: {
              FunctionArn: arn,
            },
          });

        await lambda
          .getFunction({
            FunctionName: funcName,
          })
          .catch((err: any) => {});

        const testSpans: ReadableSpan[] = getTestSpans();
        const getFunctionNameSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
          return s.name === 'Lambda.GetFunction';
        });

        expect(getFunctionNameSpans.length).toBe(1);

        const functionAttributeSpan = getFunctionNameSpans[0];

        expect(functionAttributeSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME]).toBe(funcName);
        expect(functionAttributeSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_ARN]).toBe(arn);
        expect(functionAttributeSpan.kind).toBe(SpanKind.CLIENT);
      });
    }
  });

  describe('GetEventSourceMapping', () => {
    it('span has eventSourceMapping attribute in its attributes', async () => {
      const uuid = '14e0db71-abcd-4eb5-b481-8945cf9d10c2';

      nock(`https://lambda.${region}.amazonaws.com/`).post('/').reply(200, {});

      await lambda
        .getEventSourceMapping({
          UUID: uuid,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const getEventSourceMappingSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'Lambda.GetEventSourceMapping';
      });

      expect(getEventSourceMappingSpans.length).toBe(1);

      const eventSourceMappingSpan = getEventSourceMappingSpans[0];

      expect(eventSourceMappingSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_RESOURCE_MAPPING_ID]).toBe(uuid);
      expect(eventSourceMappingSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});
