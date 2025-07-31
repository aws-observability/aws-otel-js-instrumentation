// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import { SqsUrlParser } from '../src/sqs-url-parser';

describe('SqsUrlParserTest', () => {
  it('testSqsClientSpanBasicUrls', async () => {
    validateGetQueueName('https://sqs.us-east-1.amazonaws.com/123412341234/Q_Name-5', 'Q_Name-5');
    validateGetQueueName('https://sqs.af-south-1.amazonaws.com/999999999999/-_ThisIsValid', '-_ThisIsValid');
    validateGetQueueName('http://sqs.eu-west-3.amazonaws.com/000000000000/FirstQueue', 'FirstQueue');
    validateGetQueueName('sqs.sa-east-1.amazonaws.com/123456781234/SecondQueue', 'SecondQueue');
  });

  it('testSqsClientSpanLegacyFormatUrls', () => {
    validateGetQueueName('https://ap-northeast-2.queue.amazonaws.com/123456789012/MyQueue', 'MyQueue');
    validateGetQueueName('http://cn-northwest-1.queue.amazonaws.com/123456789012/MyQueue', 'MyQueue');
    validateGetQueueName('http://cn-north-1.queue.amazonaws.com/123456789012/MyQueue', 'MyQueue');
    validateGetQueueName('ap-south-1.queue.amazonaws.com/123412341234/MyLongerQueueNameHere', 'MyLongerQueueNameHere');
    validateGetQueueName('https://queue.amazonaws.com/123456789012/MyQueue', 'MyQueue');
  });

  it('testSqsClientSpanCustomUrls', () => {
    validateGetQueueName('http://127.0.0.1:1212/123456789012/MyQueue', 'MyQueue');
    validateGetQueueName('https://127.0.0.1:1212/123412341234/RRR', 'RRR');
    validateGetQueueName('127.0.0.1:1212/123412341234/QQ', 'QQ');
    validateGetQueueName('https://amazon.com/123412341234/BB', 'BB');
  });

  it('testSqsClientSpanLongUrls', () => {
    const queueName: string = 'a'.repeat(80);
    validateGetQueueName('http://127.0.0.1:1212/123456789012/' + queueName, queueName);

    const queueNameTooLong: string = 'a'.repeat(81);
    validateGetQueueName('http://127.0.0.1:1212/123456789012/' + queueNameTooLong, undefined);
  });

  it('testClientSpanSqsInvalidOrEmptyUrls', () => {
    validateGetQueueName(undefined, undefined);
    validateGetQueueName('', undefined);
    validateGetQueueName(' ', undefined);
    validateGetQueueName('/', undefined);
    validateGetQueueName('//', undefined);
    validateGetQueueName('///', undefined);
    validateGetQueueName('//asdf', undefined);
    validateGetQueueName('/123412341234/as&df', undefined);
    validateGetQueueName('invalidUrl', undefined);
    validateGetQueueName('https://www.amazon.com', undefined);
    validateGetQueueName('https://sqs.us-east-1.amazonaws.com/123412341234/.', undefined);
    validateGetQueueName('https://sqs.us-east-1.amazonaws.com/12341234xxxx/.', undefined);
    validateGetQueueName('https://sqs.us-east-1.amazonaws.com/A/A', undefined);
    validateGetQueueName('https://sqs.us-east-1.amazonaws.com/123412341234/A/ThisShouldNotBeHere', undefined);
  });

  it('testGetAccountId', () => {
    validateGetAccountId(undefined, undefined);
    validateGetAccountId('', undefined);
    validateGetAccountId(' ', undefined);
    validateGetAccountId('/', undefined);
    validateGetAccountId('//', undefined);
    validateGetAccountId('///', undefined);
    validateGetAccountId('//asdf', undefined);
    validateGetAccountId('/123412341234/as&df', undefined);
    validateGetAccountId('invalidUrl', undefined);
    validateGetAccountId('https://www.amazon.com', undefined);
    validateGetAccountId('https://sqs.us-east-1.amazonaws.com/12341234/Queue', '12341234');
    validateGetAccountId('https://sqs.us-east-1.amazonaws.com/1234123412xx/Queue', undefined);
    validateGetAccountId('https://sqs.us-east-1.amazonaws.com/1234123412xx', undefined);
    validateGetAccountId('https://sqs.us-east-1.amazonaws.com/123412341234/Q_Namez-5', '123412341234');
  });

  it('testGetRegion', () => {
    validateGetRegion(undefined, undefined);
    validateGetRegion('', undefined);
    validateGetRegion(' ', undefined);
    validateGetRegion('/', undefined);
    validateGetRegion('//', undefined);
    validateGetRegion('///', undefined);
    validateGetRegion('//asdf', undefined);
    validateGetRegion('/123412341234/as&df', undefined);
    validateGetRegion('invalidUrl', undefined);
    validateGetRegion('https://www.amazon.com', undefined);
    validateGetRegion('https://sqs.us-east-1.amazonaws.com/12341234/Queue', 'us-east-1');
    validateGetRegion('https://sqs.us-east-1.amazonaws.com/1234123412xx/Queue', undefined);
    validateGetRegion('https://sqs.us-east-1.amazonaws.com/1234123412xx', undefined);
    validateGetRegion('https://sqs.us-east-1.amazonaws.com/123412341234/Q_Namez-5', 'us-east-1');
  });
});

function validateGetRegion(url: string | undefined, expectedRegion: string | undefined): void {
  expect(SqsUrlParser.getRegion(url)).toEqual(expectedRegion);
}

function validateGetAccountId(url: string | undefined, expectedAccountId: string | undefined): void {
  expect(SqsUrlParser.getAccountId(url)).toEqual(expectedAccountId);
}

function validateGetQueueName(url: string | undefined, expectedName: string | undefined): void {
  expect(SqsUrlParser.getQueueName(url)).toEqual(expectedName);
}
