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

/**
 * Mapping of JSON field paths (in request params and response bodies) to span attribute keys.
 * Matches the Python ADOT implementation in _bedrock_agentcore_patches.py.
 */
const ATTRIBUTE_MAPPING: Record<string, string> = {
  agentRuntimeArn: AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_RUNTIME_ARN,
  agentRuntimeEndpointArn: AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_RUNTIME_ENDPOINT_ARN,
  agentRuntimeId: AWS_ATTRIBUTE_KEYS.GEN_AI_RUNTIME_ID,
  browserArn: AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_BROWSER_ARN,
  browserId: AWS_ATTRIBUTE_KEYS.GEN_AI_BROWSER_ID,
  browserIdentifier: AWS_ATTRIBUTE_KEYS.GEN_AI_BROWSER_ID,
  codeInterpreterArn: AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_CODE_INTERPRETER_ARN,
  codeInterpreterId: AWS_ATTRIBUTE_KEYS.GEN_AI_CODE_INTERPRETER_ID,
  codeInterpreterIdentifier: AWS_ATTRIBUTE_KEYS.GEN_AI_CODE_INTERPRETER_ID,
  gatewayArn: AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_GATEWAY_ARN,
  gatewayId: AWS_ATTRIBUTE_KEYS.GEN_AI_GATEWAY_ID,
  gatewayIdentifier: AWS_ATTRIBUTE_KEYS.GEN_AI_GATEWAY_ID,
  targetId: AWS_ATTRIBUTE_KEYS.AWS_GATEWAY_TARGET_ID,
  'memory.arn': AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_MEMORY_ARN,
  'memory.id': AWS_ATTRIBUTE_KEYS.GEN_AI_MEMORY_ID,
  memoryId: AWS_ATTRIBUTE_KEYS.GEN_AI_MEMORY_ID,
  credentialProviderArn: AWS_ATTRIBUTE_KEYS.AWS_AUTH_CREDENTIAL_PROVIDER,
  resourceCredentialProviderName: AWS_ATTRIBUTE_KEYS.AWS_AUTH_CREDENTIAL_PROVIDER,
  workloadIdentityArn: AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_WORKLOAD_IDENTITY_ARN,
  'workloadIdentityDetails.workloadIdentityArn': AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_WORKLOAD_IDENTITY_ARN,
};

/**
 * Get a value from a nested object using dot-notation path.
 */
function getNestedValue(data: Record<string, any>, path: string): string | undefined {
  const keys = path.split('.');
  let value: any = data;
  for (const key of keys) {
    if (value == null || typeof value !== 'object') {
      return undefined;
    }
    value = value[key];
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extract all matching attributes from a params/response object using the attribute mapping.
 */
function extractAttributes(data: Record<string, any> | undefined): Attributes {
  const attrs: Attributes = {};
  if (!data) {
    return attrs;
  }
  for (const [path, attrKey] of Object.entries(ATTRIBUTE_MAPPING)) {
    const value = getNestedValue(data, path);
    if (value) {
      attrs[attrKey] = value;
    }
  }
  return attrs;
}

/**
 * Service extension for Bedrock AgentCore (data plane).
 * Extracts resource identifiers from request params and response bodies.
 */
export class BedrockAgentCoreServiceExtension implements ServiceExtension {
  requestPreSpanHook(
    request: NormalizedRequest,
    config: AwsSdkInstrumentationConfig,
    diag: DiagLogger
  ): RequestMetadata {
    const spanAttributes = extractAttributes(request.commandInput);
    return {
      isIncoming: false,
      spanAttributes,
      spanKind: SpanKind.CLIENT,
      spanName: undefined,
    };
  }

  responseHook(response: NormalizedResponse, span: Span, tracer: Tracer, config: AwsSdkInstrumentationConfig): void {
    const attrs = extractAttributes(response.data);
    for (const [key, value] of Object.entries(attrs)) {
      if (value) {
        span.setAttribute(key, value);
      }
    }
  }
}
