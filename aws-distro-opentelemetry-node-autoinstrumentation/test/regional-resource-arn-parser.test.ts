// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import { RegionalResourceArnParser } from '../src/regional-resource-arn-parser';

describe('RegionalResourceArnParserTest', () => {
  it('testGetAccountId', () => {
    validateAccountId(undefined, undefined);
    validateAccountId('', undefined);
    validateAccountId(' ', undefined);
    validateAccountId(':', undefined);
    validateAccountId('::::::', undefined);
    validateAccountId('not:an:arn:string', undefined);
    validateAccountId('arn:aws:ec2:us-west-2:123456', undefined);
    validateAccountId('arn:aws:ec2:us-west-2:1234567xxxxx', undefined);
    validateAccountId('arn:aws:ec2:us-west-2:123456789012', undefined);
    validateAccountId('arn:aws:dynamodb:us-west-2:123456789012:table/test_table', '123456789012');
    validateAccountId('arn:aws:acm:us-east-1:123456789012:certificate:abc-123', '123456789012');
  });

  it('testGetRegion', () => {
    validateRegion(undefined, undefined);
    validateRegion('', undefined);
    validateRegion(' ', undefined);
    validateRegion(':', undefined);
    validateRegion('::::::', undefined);
    validateRegion('not:an:arn:string', undefined);
    validateRegion('arn:aws:ec2:us-west-2:123456', undefined);
    validateRegion('arn:aws:ec2:us-west-2:1234567xxxxx', undefined);
    validateRegion('arn:aws:ec2:us-west-2:123456789012', undefined);
    validateRegion('arn:aws:dynamodb:us-west-2:123456789012:table/test_table', 'us-west-2');
    validateRegion('arn:aws:acm:us-east-1:123456789012:certificate:abc-123', 'us-east-1');
  });
});

function validateAccountId(arn: string | undefined, expectedAccountId: string | undefined): void {
  expect(RegionalResourceArnParser.getAccountId(arn)).toEqual(expectedAccountId);
}

function validateRegion(arn: string | undefined, expectedName: string | undefined): void {
  expect(RegionalResourceArnParser.getRegion(arn)).toEqual(expectedName);
}
