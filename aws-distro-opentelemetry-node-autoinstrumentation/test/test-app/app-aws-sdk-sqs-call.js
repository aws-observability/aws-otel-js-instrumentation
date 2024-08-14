// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Used in register.patch.test.ts to mimic a JS app using SQS client of AWS SDK for JS (v3).
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

const sqsClient = new SQSClient({});
const queueUrl = "https://sqs.us-east-1.amazonaws.com/012345678910/sqs-queue-name";

const promises = [sqsClient].map(entity => {
    return entity.send(
        new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: "my-message-body",
        })
    );
});

Promise.all(promises).catch(e => {
  console.error("Exception thrown", e.message);
});
