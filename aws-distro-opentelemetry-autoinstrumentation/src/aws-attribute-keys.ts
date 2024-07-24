/*
 * Copyright Amazon.com, Inc. or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

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
  APPSIGNALS_IS_LOCAL_ROOT: 'appsignals.is.local.root',

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
