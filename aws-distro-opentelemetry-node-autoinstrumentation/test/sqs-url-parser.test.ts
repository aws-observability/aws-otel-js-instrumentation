// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import { SqsUrlParser } from '../src/sqs-url-parser';

describe('SqsUrlParserTest', () => {
  it('testSqsClientSpanBasicUrls', async () => {
    validate('https://sqs.us-east-1.amazonaws.com/123412341234/Q_Name-5', 'Q_Name-5');
    validate('https://sqs.af-south-1.amazonaws.com/999999999999/-_ThisIsValid', '-_ThisIsValid');
    validate('http://sqs.eu-west-3.amazonaws.com/000000000000/FirstQueue', 'FirstQueue');
    validate('sqs.sa-east-1.amazonaws.com/123456781234/SecondQueue', 'SecondQueue');
  });

  it('testSqsClientSpanLegacyFormatUrls', () => {
    validate('https://ap-northeast-2.queue.amazonaws.com/123456789012/MyQueue', 'MyQueue');
    validate('http://cn-northwest-1.queue.amazonaws.com/123456789012/MyQueue', 'MyQueue');
    validate('http://cn-north-1.queue.amazonaws.com/123456789012/MyQueue', 'MyQueue');
    validate('ap-south-1.queue.amazonaws.com/123412341234/MyLongerQueueNameHere', 'MyLongerQueueNameHere');
    validate('https://queue.amazonaws.com/123456789012/MyQueue', 'MyQueue');
  });

  it('testSqsClientSpanCustomUrls', () => {
    validate('http://127.0.0.1:1212/123456789012/MyQueue', 'MyQueue');
    validate('https://127.0.0.1:1212/123412341234/RRR', 'RRR');
    validate('127.0.0.1:1212/123412341234/QQ', 'QQ');
    validate('https://amazon.com/123412341234/BB', 'BB');
  });

  it('testSqsClientSpanLongUrls', () => {
    const queueName: string = 'a'.repeat(80);
    validate('http://127.0.0.1:1212/123456789012/' + queueName, queueName);

    const queueNameTooLong: string = 'a'.repeat(81);
    validate('http://127.0.0.1:1212/123456789012/' + queueNameTooLong, undefined);
  });

  it('testClientSpanSqsInvalidOrEmptyUrls', () => {
    validate(undefined, undefined);
    validate('', undefined);
    validate(' ', undefined);
    validate('/', undefined);
    validate('//', undefined);
    validate('///', undefined);
    validate('//asdf', undefined);
    validate('/123412341234/as&df', undefined);
    validate('invalidUrl', undefined);
    validate('https://www.amazon.com', undefined);
    validate('https://sqs.us-east-1.amazonaws.com/123412341234/.', undefined);
    validate('https://sqs.us-east-1.amazonaws.com/12/Queue', undefined);
    validate('https://sqs.us-east-1.amazonaws.com/A/A', undefined);
    validate('https://sqs.us-east-1.amazonaws.com/123412341234/A/ThisShouldNotBeHere', undefined);
  });
});

function validate(url: string | undefined, expectedName: string | undefined): void {
  expect(SqsUrlParser.getQueueName(url)).toEqual(expectedName);
}
