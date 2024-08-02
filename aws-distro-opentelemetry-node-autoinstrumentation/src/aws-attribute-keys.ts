// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Utility class holding attribute keys with special meaning to AWS components
export const AWS_ATTRIBUTE_KEYS: { [key: string]: string } = {
  AWS_SPAN_KIND: 'aws.span.kind',
  AWS_LOCAL_SERVICE: 'aws.local.service',
  AWS_LOCAL_OPERATION: 'aws.local.operation',
  AWS_REMOTE_SERVICE: 'aws.remote.service',
  AWS_REMOTE_OPERATION: 'aws.remote.operation',
  AWS_REMOTE_RESOURCE_TYPE: 'aws.remote.resource.type',
  AWS_REMOTE_RESOURCE_IDENTIFIER: 'aws.remote.resource.identifier',
  AWS_SDK_DESCENDANT: 'aws.sdk.descendant',
  AWS_CONSUMER_PARENT_SPAN_KIND: 'aws.consumer.parent.span.kind',

  AWS_REMOTE_TARGET: 'aws.remote.target',
  AWS_REMOTE_DB_USER: 'aws.remote.db.user',

  // Used for JavaScript workaround - attribute for pre-calculated value of isLocalRoot
  AWS_IS_LOCAL_ROOT: 'aws.is.local.root',

  // Divergence from Java/Python
  // TODO: Audit this: These will most definitely be different in JavaScript.
  //   For example:
  //     - `messaging.url` for AWS_QUEUE_URL
  //     - `aws.dynamodb.table_names` for AWS_TABLE_NAME
  AWS_BUCKET_NAME: 'aws.bucket.name',
  AWS_QUEUE_URL: 'aws.queue.url',
  AWS_QUEUE_NAME: 'aws.queue.name',
  AWS_STREAM_NAME: 'aws.stream.name',
  AWS_TABLE_NAME: 'aws.table.name',
};
