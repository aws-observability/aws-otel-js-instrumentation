// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTestSpans, registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { applyInstrumentationPatches } from './../../../../src/patches/instrumentation-patch';

const instrumentations: AwsInstrumentation[] = [new AwsInstrumentation()];
applyInstrumentationPatches(instrumentations);
registerInstrumentationTesting(instrumentations[0]);

import { Kinesis } from '@aws-sdk/client-kinesis';
import * as nock from 'nock';

import { SpanKind } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../../../src/aws-attribute-keys';

// This file's contents are being contributed to upstream
// - https://github.com/open-telemetry/opentelemetry-js-contrib/pull/2361

const region = 'us-east-1';

describe('Kinesis', () => {
  let kinesis: Kinesis;
  beforeEach(() => {
    kinesis = new Kinesis({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });

    nock(`https://kinesis.${region}.amazonaws.com`).post('/').reply(200, {});
  });

  describe('DescribeStream', () => {
    it('adds Stream Name', async () => {
      const dummyStreamName: string = 'dummy-stream-name';
      await kinesis
        .describeStream({
          StreamName: dummyStreamName,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const describeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'Kinesis.DescribeStream';
      });
      expect(describeSpans.length).toBe(1);
      const creationSpan = describeSpans[0];
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME]).toBe(dummyStreamName);
      expect(creationSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});
