// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SEMATTRS_AWS_DYNAMODB_TABLE_NAMES } from '@opentelemetry/semantic-conventions';

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

  // Trace Span Unsampled flag
  AWS_TRACE_FLAG_SAMPLED: 'aws.trace.flag.sampled',

  // AWS_#_NAME attributes are not supported in JavaScript as they are not part of the Semantic Conventions.
  // TODO：Move to Semantic Conventions when these attributes are added.
  AWS_S3_BUCKET: 'aws.s3.bucket',
  AWS_SQS_QUEUE_URL: 'aws.sqs.queue.url',
  AWS_SQS_QUEUE_NAME: 'aws.sqs.queue.name',
  AWS_KINESIS_STREAM_NAME: 'aws.kinesis.stream.name',
  AWS_DYNAMODB_TABLE_NAMES: SEMATTRS_AWS_DYNAMODB_TABLE_NAMES,
  AWS_BEDROCK_DATA_SOURCE_ID: 'aws.bedrock.data_source.id',
  AWS_BEDROCK_KNOWLEDGE_BASE_ID: 'aws.bedrock.knowledge_base.id',
  AWS_BEDROCK_AGENT_ID: 'aws.bedrock.agent.id',
  AWS_BEDROCK_GUARDRAIL_ID: 'aws.bedrock.guardrail.id',
};
