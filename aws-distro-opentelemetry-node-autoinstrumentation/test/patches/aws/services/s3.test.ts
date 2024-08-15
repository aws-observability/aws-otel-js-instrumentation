// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTestSpans, registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { applyInstrumentationPatches } from './../../../../src/patches/instrumentation-patch';

const instrumentations: AwsInstrumentation[] = [new AwsInstrumentation()];
applyInstrumentationPatches(instrumentations);
registerInstrumentationTesting(instrumentations[0]);

import { S3 } from '@aws-sdk/client-s3';
import * as nock from 'nock';

import { SpanKind } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../../../src/aws-attribute-keys';

// This file's contents are being contributed to upstream
// - https://github.com/open-telemetry/opentelemetry-js-contrib/pull/2361

const region = 'us-east-1';

describe('S3', () => {
  let s3: S3;
  beforeEach(() => {
    s3 = new S3({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });

  describe('ListObjects', () => {
    it('adds bucket Name', async () => {
      const dummyBucketName: string = 'dummy-bucket-name';

      nock(`https://s3.${region}.amazonaws.com/`).post('/').reply(200, 'null');

      await s3
        .listObjects({
          Bucket: dummyBucketName,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const listObjectsSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'S3.ListObjects';
      });
      expect(listObjectsSpans.length).toBe(1);
      const listObjectsSpan = listObjectsSpans[0];
      expect(listObjectsSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET]).toBe(dummyBucketName);
      expect(listObjectsSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});
