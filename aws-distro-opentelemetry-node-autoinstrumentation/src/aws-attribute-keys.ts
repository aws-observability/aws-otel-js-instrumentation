// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  SEMATTRS_AWS_DYNAMODB_TABLE_NAMES,
  SEMATTRS_MESSAGING_DESTINATION,
  SEMATTRS_MESSAGING_URL,
} from '@opentelemetry/semantic-conventions';

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
  // For consistency between ADOT SDK languages, the attribute Key name is named similarly to Java/Python,
  // while the value is different to accommodate the actual attribute set from OTel JS instrumentations
  AWS_BUCKET_NAME: 'aws.s3.bucket',
  AWS_QUEUE_URL: SEMATTRS_MESSAGING_URL,
  AWS_QUEUE_NAME: SEMATTRS_MESSAGING_DESTINATION,
  AWS_STREAM_NAME: 'aws.kinesis.stream.name',
  AWS_TABLE_NAMES: SEMATTRS_AWS_DYNAMODB_TABLE_NAMES,
};
