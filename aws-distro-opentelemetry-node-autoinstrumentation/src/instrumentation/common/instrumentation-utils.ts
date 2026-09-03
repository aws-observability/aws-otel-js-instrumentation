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

export function resolveProviderName(provider: string): string {
  if (!provider) return provider;
  const lower = provider.toLowerCase();

  if (PROVIDER_MAP[lower]) return PROVIDER_MAP[lower];

  for (const [prefix, mapped] of Object.entries(PROVIDER_MAP)) {
    if (lower.startsWith(prefix + '.') || lower.startsWith(prefix + '-')) {
      return mapped;
    }
  }

  return provider;
}

export interface AttributeMapping {
  from: string;
  to?: string;
  transform?: (value: any, attrs: Record<string, any>) => any;
  // Apply the mapping even when the destination attribute already exists.
  override?: boolean;
}

export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function serializeToJson(value: unknown, maxDepth: number = 10): string {
  const seen = new WeakSet<object>();
  const sanitize = (obj: unknown, depth: number): unknown => {
    if (depth <= 0) return '...';
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return obj;
    const encodedBinary = binaryToBase64(obj);
    if (encodedBinary !== undefined) return encodedBinary;
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

export function toToolAttributeValue(value: unknown): string | number | boolean | undefined {
  try {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    return binaryToBase64(value) ?? serializeToJson(value);
  } catch {
    return undefined;
  }
}

export function contentToParts(content: unknown): Array<Record<string, unknown>> {
  try {
    if (typeof content === 'string') {
      return content ? [{ type: 'text', content }] : [];
    }
    let blocks: unknown[];
    if (isRecord(content)) {
      blocks = [content];
    } else if (Array.isArray(content)) {
      blocks = content;
    } else {
      return content === null || content === undefined ? [] : [{ type: 'text', content: String(content) }];
    }

    const parts: Array<Record<string, unknown>> = [];
    for (const block of blocks) {
      if (typeof block === 'string') {
        if (block) parts.push({ type: 'text', content: block });
        continue;
      }
      if (!isRecord(block)) {
        parts.push({ type: 'text', content: String(block) });
        continue;
      }

      const blockType = typeof block.type === 'string' ? block.type : '';
      if (blockType === 'text') {
        if (block.text !== null && block.text !== undefined && block.text !== '') {
          parts.push({ type: 'text', content: String(block.text) });
        }
      } else if (blockType === 'thinking' || blockType === 'reasoning') {
        const reasoning = block.thinking || block.reasoning || block.content;
        if (reasoning) {
          parts.push({ type: 'reasoning', content: String(reasoning) });
        }
      } else if (blockType === 'image_url') {
        const imageUrl = isRecord(block.image_url) ? block.image_url.url : undefined;
        if (typeof imageUrl !== 'string' || !imageUrl) continue;
        if (imageUrl.startsWith('data:')) {
          // https://www.rfc-editor.org/rfc/rfc2397#section-3
          const payload = imageUrl.slice('data:'.length);
          const commaIndex = payload.indexOf(',');
          const header = commaIndex >= 0 ? payload.slice(0, commaIndex) : payload;
          const data = commaIndex >= 0 ? payload.slice(commaIndex + 1) : '';
          parts.push({
            type: 'blob',
            modality: 'image',
            mime_type: header.split(';', 1)[0] || 'image/*',
            content: data,
          });
        } else {
          parts.push({ type: 'uri', modality: 'image', uri: imageUrl });
        }
      } else if (blockType === 'image') {
        parts.push({
          type: 'blob',
          modality: 'image',
          mime_type: block.media_type || block.mime_type || 'image/*',
          content: block.data ?? '',
        });
      } else {
        parts.push({ ...block, type: blockType || 'text' });
      }
    }
    return parts;
  } catch {
    return [];
  }
}

function binaryToBase64(value: unknown): string | undefined {
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value)).toString('base64');
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).toString('base64');
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
