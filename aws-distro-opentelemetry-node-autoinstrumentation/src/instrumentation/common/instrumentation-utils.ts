// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
  GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
  GEN_AI_PROVIDER_NAME_VALUE_COHERE,
  GEN_AI_PROVIDER_NAME_VALUE_DEEPSEEK,
  GEN_AI_PROVIDER_NAME_VALUE_GCP_GEMINI,
  GEN_AI_PROVIDER_NAME_VALUE_GCP_GEN_AI,
  GEN_AI_PROVIDER_NAME_VALUE_GCP_VERTEX_AI,
  GEN_AI_PROVIDER_NAME_VALUE_GROQ,
  GEN_AI_PROVIDER_NAME_VALUE_MISTRAL_AI,
  GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
  GEN_AI_PROVIDER_NAME_VALUE_PERPLEXITY,
  GEN_AI_PROVIDER_NAME_VALUE_X_AI,
} from './semconv';

export const PROVIDER_MAP: Record<string, string> = {
  bedrock: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  'amazon-bedrock': GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  amazon_bedrock: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  'bedrock-converse': GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  aws: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  langchain_aws: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  openai: GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
  anthropic: GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
  claude: GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
  azure: GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
  azure_openai: GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI,
  google: GEN_AI_PROVIDER_NAME_VALUE_GCP_GEN_AI,
  google_genai: GEN_AI_PROVIDER_NAME_VALUE_GCP_GEN_AI,
  'google-genai': GEN_AI_PROVIDER_NAME_VALUE_GCP_GEN_AI,
  langchain_google_genai: GEN_AI_PROVIDER_NAME_VALUE_GCP_GEN_AI,
  vertex: GEN_AI_PROVIDER_NAME_VALUE_GCP_VERTEX_AI,
  vertexai: GEN_AI_PROVIDER_NAME_VALUE_GCP_VERTEX_AI,
  'google-vertexai': GEN_AI_PROVIDER_NAME_VALUE_GCP_VERTEX_AI,
  gemini: GEN_AI_PROVIDER_NAME_VALUE_GCP_GEMINI,
  cohere: GEN_AI_PROVIDER_NAME_VALUE_COHERE,
  langchain_cohere: GEN_AI_PROVIDER_NAME_VALUE_COHERE,
  mistral: GEN_AI_PROVIDER_NAME_VALUE_MISTRAL_AI,
  mistralai: GEN_AI_PROVIDER_NAME_VALUE_MISTRAL_AI,
  groq: GEN_AI_PROVIDER_NAME_VALUE_GROQ,
  langchain_groq: GEN_AI_PROVIDER_NAME_VALUE_GROQ,
  deepseek: GEN_AI_PROVIDER_NAME_VALUE_DEEPSEEK,
  langchain_deepseek: GEN_AI_PROVIDER_NAME_VALUE_DEEPSEEK,
  perplexity: GEN_AI_PROVIDER_NAME_VALUE_PERPLEXITY,
  xai: GEN_AI_PROVIDER_NAME_VALUE_X_AI,
  langchain_xai: GEN_AI_PROVIDER_NAME_VALUE_X_AI,
};

export interface AttributeMapping {
  from: string;
  to?: string;
  transform?: (value: any, attrs: Record<string, any>) => any;
}

export function serializeToJson(value: unknown, maxDepth: number = 10): string {
  const seen = new WeakSet<object>();
  const sanitize = (obj: unknown, depth: number): unknown => {
    if (depth <= 0) return '...';
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return obj;
    if (typeof obj === 'object') {
      if (seen.has(obj as object)) return '[Circular]';
      seen.add(obj as object);
      if (Array.isArray(obj)) return obj.map(item => sanitize(item, depth - 1));
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        result[key] = sanitize(val, depth - 1);
      }
      return result;
    }
    return String(obj);
  };

  try {
    return JSON.stringify(sanitize(value, maxDepth));
  } catch {
    return String(value);
  }
}
