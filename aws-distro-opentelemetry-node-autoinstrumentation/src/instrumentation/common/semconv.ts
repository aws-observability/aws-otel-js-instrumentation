// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * This file contains a copy of unstable semantic convention definitions used by this package.
 * These are copied from @opentelemetry/semantic-conventions/incubating to avoid depending on
 * the incubating entry point directly, which is not recommended for production use.
 *
 * @see https://github.com/open-telemetry/opentelemetry-js/tree/main/semantic-conventions
 */

export const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
export const ATTR_GEN_AI_INPUT_MESSAGES = 'gen_ai.input.messages';
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const ATTR_GEN_AI_OUTPUT_MESSAGES = 'gen_ai.output.messages';
export const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
export const ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY = 'gen_ai.request.frequency_penalty';
export const ATTR_GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY = 'gen_ai.request.presence_penalty';
export const ATTR_GEN_AI_REQUEST_STOP_SEQUENCES = 'gen_ai.request.stop_sequences';
export const ATTR_GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';
export const ATTR_GEN_AI_REQUEST_TOP_K = 'gen_ai.request.top_k';
export const ATTR_GEN_AI_REQUEST_TOP_P = 'gen_ai.request.top_p';
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons';
export const ATTR_GEN_AI_RESPONSE_ID = 'gen_ai.response.id';
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const ATTR_GEN_AI_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';
export const ATTR_GEN_AI_TOOL_CALL_ARGUMENTS = 'gen_ai.tool.call.arguments';
export const ATTR_GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id';
export const ATTR_GEN_AI_TOOL_CALL_RESULT = 'gen_ai.tool.call.result';
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const ATTR_GEN_AI_TOOL_TYPE = 'gen_ai.tool.type';
export const ATTR_GEN_AI_TOOL_DEFINITIONS = 'gen_ai.tool.definitions';
export const ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS = 'gen_ai.usage.cache_creation_input_tokens';
export const ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read_input_tokens';
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const ATTR_GEN_AI_OUTPUT_TYPE = 'gen_ai.output.type';

export const GEN_AI_OPERATION_NAME_VALUE_CHAT = 'chat';
export const GEN_AI_OPERATION_NAME_VALUE_EMBEDDINGS = 'embeddings';
export const GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL = 'execute_tool';
export const GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT = 'invoke_agent';
export const GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION = 'text_completion';

export const GEN_AI_OUTPUT_TYPE_VALUE_TEXT = 'text';
export const GEN_AI_OUTPUT_TYPE_VALUE_JSON = 'json';

export const GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC = 'anthropic';
export const GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK = 'aws.bedrock';
export const GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI = 'azure.ai.openai';
export const GEN_AI_PROVIDER_NAME_VALUE_COHERE = 'cohere';
export const GEN_AI_PROVIDER_NAME_VALUE_DEEPSEEK = 'deepseek';
export const GEN_AI_PROVIDER_NAME_VALUE_GCP_GEMINI = 'gcp.gemini';
export const GEN_AI_PROVIDER_NAME_VALUE_GCP_GEN_AI = 'gcp.gen_ai';
export const GEN_AI_PROVIDER_NAME_VALUE_GCP_VERTEX_AI = 'gcp.vertex_ai';
export const GEN_AI_PROVIDER_NAME_VALUE_GROQ = 'groq';
export const GEN_AI_PROVIDER_NAME_VALUE_MISTRAL_AI = 'mistral_ai';
export const GEN_AI_PROVIDER_NAME_VALUE_OPENAI = 'openai';
export const GEN_AI_PROVIDER_NAME_VALUE_PERPLEXITY = 'perplexity';
export const GEN_AI_PROVIDER_NAME_VALUE_X_AI = 'x_ai';
