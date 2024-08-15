// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Used in register.patch.test.ts to mimic a JS app using SQS client of AWS SDK for JS (v3).
const { S3Client, ListObjectsCommand } = require("@aws-sdk/client-s3");
const { KinesisClient, ListStreamsCommand } = require('@aws-sdk/client-kinesis');
const { SQSClient, ReceiveMessageCommand } = require("@aws-sdk/client-sqs");

const s3Client = new S3Client({});
const bucketName = "test-bucket-not-exists";

const kinesisClient = new KinesisClient({});
const streamName = "my-kinesis-stream";

const sqsClient = new SQSClient({});
const queueUrl = "https://sqs.us-east-1.amazonaws.com/012345678910/sqs-queue-name";

const awsSdkClientSendPromises = [
    s3Client.send(
        new ListObjectsCommand({
            Bucket: bucketName
        })
    ),
    kinesisClient.send(
        new ListStreamsCommand({
            StreamName: streamName,
        })
    ),
    sqsClient.send(
        new ReceiveMessageCommand({
            QueueUrl: queueUrl
        })
    ),
]

Promise.all(awsSdkClientSendPromises).catch(e => {
  console.error("Exception thrown", e.message);
});
