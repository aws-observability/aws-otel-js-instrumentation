// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { getAwsRegionFromEnvironment } from '../src/utils';

describe('Utils', function () {
  beforeEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  it('Test getAwsRegion from AWS_REGION env var', () => {
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_DEFAULT_REGION = 'eu-west-1';
    expect(getAwsRegionFromEnvironment()).toEqual('us-west-2');
  });

  it('Test getAwsRegion from AWS_REGION env var', () => {
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = 'eu-west-1';
    expect(getAwsRegionFromEnvironment()).toEqual('eu-west-1');
  });
});
