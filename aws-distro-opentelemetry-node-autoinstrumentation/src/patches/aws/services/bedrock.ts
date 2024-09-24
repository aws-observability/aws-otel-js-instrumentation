// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, DiagLogger, Span, SpanKind, Tracer } from '@opentelemetry/api';
import {
  AwsSdkInstrumentationConfig,
  NormalizedRequest,
  NormalizedResponse,
} from '@opentelemetry/instrumentation-aws-sdk';
import { AWS_ATTRIBUTE_KEYS } from '../../../aws-attribute-keys';
import { RequestMetadata, ServiceExtension } from '../../../third-party/otel/aws/services/ServiceExtension';
import { AwsSpanProcessingUtil } from '../../../aws-span-processing-util';

const AGENT_ID: string = 'agentId';
const KNOWLEDGE_BASE_ID: string = 'knowledgeBaseId';
const DATA_SOURCE_ID: string = 'dataSourceId';
const GUARDRAIL_ID: string = 'guardrailId';
const MODEL_ID: string = 'modelId';
const AWS_BEDROCK_SYSTEM: string = 'aws_bedrock';

const AGENT_OPERATIONS = [
  'CreateAgentActionGroup',
  'CreateAgentAlias',
  'DeleteAgentActionGroup',
  'DeleteAgentAlias',
  'DeleteAgent',
  'DeleteAgentVersion',
  'GetAgentActionGroup',
  'GetAgentAlias',
  'GetAgent',
  'GetAgentVersion',
  'ListAgentActionGroups',
  'ListAgentAliases',
  'ListAgentKnowledgeBases',
  'ListAgentVersions',
  'PrepareAgent',
  'UpdateAgentActionGroup',
  'UpdateAgentAlias',
  'UpdateAgent',
];

const KNOWLEDGE_BASE_OPERATIONS = [
  'AssociateAgentKnowledgeBase',
  'CreateDataSource',
  'DeleteKnowledgeBase',
  'DisassociateAgentKnowledgeBase',
  'GetAgentKnowledgeBase',
  'GetKnowledgeBase',
  'ListDataSources',
  'UpdateAgentKnowledgeBase',
];

const DATA_SOURCE_OPERATIONS = ['DeleteDataSource', 'GetDataSource', 'UpdateDataSource'];

// The following constants map the way we present the data in telemetry to how they appear in request/responses
// e.g. we put `aws.bedrock.knowledge_base.id` into trace data by finding `knowledgeBaseId`
const agentOperationAttributeKeyMapping = { [AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]: AGENT_ID };
const knowledgeBaseOperationAttributeKeyMapping = {
  [AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]: KNOWLEDGE_BASE_ID,
};
const dataSourceOperationAttributeKeyMapping = {
  [AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]: DATA_SOURCE_ID,
};

// This map allows us to get all relevant attribute key mappings for a given operation
const operationToBedrockAgentAttributesMap: { [key: string]: { [key: string]: string } } = {};
for (const operation of AGENT_OPERATIONS) {
  operationToBedrockAgentAttributesMap[operation] = agentOperationAttributeKeyMapping;
}
for (const operation of KNOWLEDGE_BASE_OPERATIONS) {
  operationToBedrockAgentAttributesMap[operation] = knowledgeBaseOperationAttributeKeyMapping;
}
for (const operation of DATA_SOURCE_OPERATIONS) {
  operationToBedrockAgentAttributesMap[operation] = dataSourceOperationAttributeKeyMapping;
}

// This class is an extension for <a
// href="https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Agents_for_Amazon_Bedrock.html">
// Agents for Amazon Bedrock</a>.
// This class primarily identify three types of resource based operations: AGENT_OPERATIONS,
// KNOWLEDGE_BASE_OPERATIONS, and DATA_SOURCE_OPERATIONS. We only support operations that are related to
// the resource and where the context contains the resource ID.
export class BedrockAgentServiceExtension implements ServiceExtension {
  requestPreSpanHook(
    request: NormalizedRequest,
    config: AwsSdkInstrumentationConfig,
    diag: DiagLogger
  ): RequestMetadata {
    const spanAttributes: Attributes = {};
    const isIncoming = false;
    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;

    const operation: string = request.commandName;
    if (operation && operationToBedrockAgentAttributesMap[operation]) {
      const bedrockAgentServiceInfo = operationToBedrockAgentAttributesMap[operation];
      for (const serviceInfo of Object.entries(bedrockAgentServiceInfo)) {
        const [attributeKey, requestParamKey] = serviceInfo;
        const requestParamValue = request.commandInput?.[requestParamKey];

        if (requestParamValue) {
          spanAttributes[attributeKey] = requestParamValue;
        }
      }
    }

    return {
      isIncoming,
      spanAttributes,
      spanKind,
      spanName,
    };
  }

  responseHook(response: NormalizedResponse, span: Span, tracer: Tracer, config: AwsSdkInstrumentationConfig): void {
    const operation: string = response.request.commandName;
    if (operation && Object.keys(operationToBedrockAgentAttributesMap).includes(operation)) {
      const bedrockAgentServiceInfo = operationToBedrockAgentAttributesMap[operation];
      for (const serviceInfo of Object.entries(bedrockAgentServiceInfo)) {
        const [attributeKey, responseParamKey] = serviceInfo;
        const responseParamValue = response.data[responseParamKey];

        if (responseParamValue) {
          span.setAttribute(attributeKey, responseParamValue);
        }
      }
    }
  }
}

// This class is an extension for <a
// href="https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Agents_for_Amazon_Bedrock_Runtime.html">
// Agents for Amazon Bedrock Runtime</a>.
export class BedrockAgentRuntimeServiceExtension implements ServiceExtension {
  requestPreSpanHook(
    request: NormalizedRequest,
    config: AwsSdkInstrumentationConfig,
    diag: DiagLogger
  ): RequestMetadata {
    const spanAttributes: Attributes = {};
    const isIncoming = false;
    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;

    const agentId = request.commandInput?.[AGENT_ID];
    const knowledgeBaseId = request.commandInput?.[KNOWLEDGE_BASE_ID];

    if (agentId) {
      spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID] = agentId;
    }
    if (knowledgeBaseId) {
      spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID] = knowledgeBaseId;
    }

    return {
      isIncoming,
      spanAttributes,
      spanKind,
      spanName,
    };
  }
}

// This class is an extension for <a
// href="https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Amazon_Bedrock.html">Bedrock</a>.
export class BedrockServiceExtension implements ServiceExtension {
  // Must be implemented, returning empty metadata
  requestPreSpanHook(
    request: NormalizedRequest,
    config: AwsSdkInstrumentationConfig,
    diag: DiagLogger
  ): RequestMetadata {
    const spanAttributes: Attributes = {};
    const isIncoming = false;
    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;
    return {
      isIncoming,
      spanAttributes,
      spanKind,
      spanName,
    };
  }
  responseHook(response: NormalizedResponse, span: Span, tracer: Tracer, config: AwsSdkInstrumentationConfig): void {
    const guardrail_id = response.data[GUARDRAIL_ID];

    if (guardrail_id) {
      span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ID, guardrail_id);
    }
  }
}

// This class is an extension for <a
// href="https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Amazon_Bedrock_Runtime.html">
// Amazon Bedrock Runtime</a>.
export class BedrockRuntimeServiceExtension implements ServiceExtension {
  requestPreSpanHook(
    request: NormalizedRequest,
    config: AwsSdkInstrumentationConfig,
    diag: DiagLogger
  ): RequestMetadata {
    const spanAttributes: Attributes = {};
    const isIncoming = false;
    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;

    const modelId = request.commandInput?.[MODEL_ID];

    spanAttributes[AwsSpanProcessingUtil.GEN_AI_SYSTEM] = AWS_BEDROCK_SYSTEM;
    if (modelId) {
      spanAttributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL] = modelId;
    }

    return {
      isIncoming,
      spanAttributes,
      spanKind,
      spanName,
    };
  }
}
