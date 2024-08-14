// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Used in register.patch.test.ts to mimic a JS app using Kinesis client of AWS SDK for JS (v3).
const { KinesisClient, CreateStreamCommand } = require('@aws-sdk/client-kinesis');

const kinesisClient = new KinesisClient({});
const streamName = "my-kinesis-stream";

const promises = [kinesisClient].map(entity => {
    return entity.send(
        new CreateStreamCommand({
            StreamName: streamName,
            ShardCount: 5
        })
    );
});

Promise.all(promises).catch(e => {
  console.error("Exception thrown", e.message);
});
