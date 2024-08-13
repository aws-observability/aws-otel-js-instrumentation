// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Used in register.test.ts to mimic a JS app using S3 client of AWS SDK for JS (v3).
const { S3Client, ListObjectsCommand } = require("@aws-sdk/client-s3");

const s3Client = new S3Client({});
const bucketName = "test-bucket-not-exists";

const promises = [s3Client].map(entity => {
    return entity.send(
        new ListObjectsCommand({
            Bucket: bucketName
        })
    );
});

Promise.all(promises).catch(e => {
  console.error("Exception thrown", e.message);
});
