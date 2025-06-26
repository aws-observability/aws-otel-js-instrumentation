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
    validateAccountId('arn:aws:ec2:us-west-2:123456789012', undefined);
    validateAccountId('arn:aws:ec2:us-west-2:1234567xxxxx:table/test_table', undefined);
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

it('testExtractDynamoDbTableNameFromArn', () => {
  validateDynamoDbTableName(undefined, undefined);
  validateDynamoDbTableName('', undefined);
  validateDynamoDbTableName(' ', undefined);
  validateDynamoDbTableName(':', undefined);
  validateDynamoDbTableName('::::::', undefined);
  validateDynamoDbTableName('not:an:arn:string', undefined);
  validateDynamoDbTableName('arn:aws:dynamodb:us-west-2:123456789012:table/test_table', 'test_table');
  validateDynamoDbTableName('arn:aws:dynamodb:us-west-2:123456789012:table/my-table-name', 'my-table-name');
});

it('testExtractKinesisStreamNameFromArn', () => {
  validateKinesisStreamName(undefined, undefined);
  validateKinesisStreamName('', undefined);
  validateKinesisStreamName(' ', undefined);
  validateKinesisStreamName(':', undefined);
  validateKinesisStreamName('::::::', undefined);
  validateKinesisStreamName('not:an:arn:string', undefined);
  validateKinesisStreamName('arn:aws:kinesis:us-west-2:123456789012:stream/test_stream', 'test_stream');
  validateKinesisStreamName('arn:aws:kinesis:us-west-2:123456789012:stream/my-stream-name', 'my-stream-name');
});

it('testExtractResourceNameFromArn', () => {
  validateResourceName(undefined, undefined);
  validateResourceName('', undefined);
  validateResourceName(' ', undefined);
  validateResourceName(':', undefined);
  validateResourceName('::::::', undefined);
  validateResourceName('not:an:arn:string', undefined);
  validateResourceName('arn:aws:dynamodb:us-west-2:123456789012:table/test_table', 'table/test_table');
  validateResourceName('arn:aws:kinesis:us-west-2:123456789012:stream/test_stream', 'stream/test_stream');
  validateResourceName('arn:aws:s3:us-west-2:123456789012:my-bucket', 'my-bucket');
});

function validateDynamoDbTableName(arn: string | undefined, expectedName: string | undefined): void {
  expect(RegionalResourceArnParser.extractDynamoDbTableNameFromArn(arn)).toEqual(expectedName);
}

function validateKinesisStreamName(arn: string | undefined, expectedName: string | undefined): void {
  expect(RegionalResourceArnParser.extractKinesisStreamNameFromArn(arn)).toEqual(expectedName);
}

function validateResourceName(arn: string | undefined, expectedName: string | undefined): void {
  expect(RegionalResourceArnParser.extractResourceNameFromArn(arn)).toEqual(expectedName);
}

function validateAccountId(arn: string | undefined, expectedAccountId: string | undefined): void {
  expect(RegionalResourceArnParser.getAccountId(arn)).toEqual(expectedAccountId);
}

function validateRegion(arn: string | undefined, expectedName: string | undefined): void {
  expect(RegionalResourceArnParser.getRegion(arn)).toEqual(expectedName);
}
