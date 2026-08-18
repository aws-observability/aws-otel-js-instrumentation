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

export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function serializeToJson(value: unknown, maxDepth: number = 10): string {
  const ancestors = new WeakSet<object>();
  const sanitize = (obj: unknown, depth: number): unknown => {
    if (depth <= 0) return '...';
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return obj;
    const encodedBinary = binaryToBase64(obj);
    if (encodedBinary !== undefined) return encodedBinary;
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: obj.message,
        stack: obj.stack,
      };
    }
    if (typeof obj === 'object') {
      if (ancestors.has(obj as object)) return '[Circular]';
      ancestors.add(obj as object);
      try {
        if (Array.isArray(obj)) return obj.map(item => sanitize(item, depth - 1));
        if (obj instanceof Map) {
          return Array.from(obj.entries(), ([key, val]) => [sanitize(key, depth - 1), sanitize(val, depth - 1)]);
        }
        if (obj instanceof Set) {
          return Array.from(obj.values(), item => sanitize(item, depth - 1));
        }
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(obj)) {
          result[key] = sanitize(val, depth - 1);
        }
        return result;
      } finally {
        ancestors.delete(obj as object);
      }
    }
    return String(obj);
  };

  try {
    if (value === undefined) return JSON.stringify('undefined');
    const serialized = JSON.stringify(sanitize(value, maxDepth));
    return serialized === undefined ? JSON.stringify('undefined') : serialized;
  } catch {
    return JSON.stringify('[Unserializable]');
  }
}

export function toToolAttributeValue(value: unknown): string | number | boolean | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  const encodedBinary = binaryToBase64(value);
  return encodedBinary ?? serializeToJson(value);
}

export function contentToParts(content: unknown): Array<Record<string, unknown>> {
  try {
    if (typeof content === 'string') {
      return content ? [{ type: 'text', content }] : [];
    }

    const blocks = Array.isArray(content) ? content : isRecord(content) ? [content] : [];
    if (blocks.length === 0) {
      return content === null || content === undefined ? [] : [{ type: 'text', content: String(content) }];
    }

    return blocks.flatMap(contentBlockToParts);
  } catch {
    return [{ type: 'text', content: '[Unserializable]' }];
  }
}

function contentBlockToParts(block: unknown): Array<Record<string, unknown>> {
  if (typeof block === 'string') {
    return block ? [{ type: 'text', content: block }] : [];
  }
  if (!isRecord(block)) {
    return [{ type: 'text', content: String(block) }];
  }

  const blockType = typeof block.type === 'string' ? block.type : '';
  if (['text', 'input_text', 'output_text'].includes(blockType)) {
    const text = block.text ?? block.content;
    return text === null || text === undefined || text === '' ? [] : [{ type: 'text', content: String(text) }];
  }

  if (['thinking', 'reasoning', 'reasoning_text', 'summary_text'].includes(blockType)) {
    const reasoning = block.thinking ?? block.reasoning ?? block.text ?? block.content;
    return reasoning === null || reasoning === undefined || reasoning === ''
      ? []
      : [{ type: 'reasoning', content: String(reasoning) }];
  }

  if (blockType === 'text-plain' && typeof block.text === 'string') {
    return [
      copySelectedFields(
        { type: 'text', content: block.text },
        [block],
        ['title', 'context', 'providerMetadata', 'providerOptions', 'providerData', 'metadata']
      ),
    ];
  }

  const modality = mediaModality(blockType);
  if (modality) {
    const mediaPart = imageContentToPart(block, modality);
    return mediaPart ? [mediaPart] : [{ ...block, type: blockType }];
  }

  if (blockType === 'tool-call' || blockType === 'tool_call' || blockType === 'tool_use') {
    const args = block.args ?? block.arguments ?? block.input ?? {};
    return [
      {
        type: 'tool_call',
        id: block.toolCallId ?? block.id ?? null,
        name: block.toolName ?? block.name ?? '',
        arguments: typeof args === 'string' ? tryParseJson(args) : args,
      },
    ];
  }

  if (blockType === 'tool-result' || blockType === 'tool_call_response') {
    return [
      {
        type: 'tool_call_response',
        id: block.toolCallId ?? block.id ?? null,
        response: block.result ?? block.response ?? block.output ?? '',
      },
    ];
  }

  if (!blockType) {
    return [{ ...block, type: 'unknown' }];
  }
  return [{ ...block, type: blockType }];
}

function imageContentToPart(block: Record<string, unknown>, modality: string): Record<string, unknown> | undefined {
  try {
    return imageContentToPartUnsafe(block, modality);
  } catch {
    return undefined;
  }
}

function imageContentToPartUnsafe(
  block: Record<string, unknown>,
  modality: string
): Record<string, unknown> | undefined {
  const source = isRecord(block.source) ? block.source : undefined;
  const inputAudio = isRecord(block.input_audio) ? block.input_audio : undefined;
  const primary = getPrimaryMediaValue(block);
  const primaryRecord = isRecord(primary) ? primary : undefined;
  const sources = [block, primaryRecord, inputAudio, source].filter(isRecord);
  const mimeType = getMimeType(sources, modality);

  const fileId = getFileId(block, primaryRecord, source);
  if (fileId) {
    return withMediaMetadata(withOptionalMimeType({ type: 'file', modality, file_id: fileId }, mimeType), sources);
  }

  const explicitUrl = block.image_url ?? block.file_url ?? block.url ?? primaryRecord?.url ?? source?.url;
  const uriPart = buildAutoMediaPart(explicitUrl, modality, mimeType, sources, false);
  if (uriPart) return uriPart;

  const base64Data = block.file_data ?? inputAudio?.data ?? primaryRecord?.data ?? block.data ?? source?.data;
  const base64Part = buildBase64MediaPart(base64Data, modality, mimeType, sources);
  if (base64Part) return base64Part;

  return buildAutoMediaPart(primary, modality, mimeType, sources, true);
}

function mediaModality(blockType: string): string | undefined {
  switch (blockType) {
    case 'image':
    case 'image_url':
    case 'input_image':
    case 'output_image':
      return 'image';
    case 'audio':
    case 'input_audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'file':
    case 'input_file':
      return 'document';
    case 'text-plain':
      return 'text';
    default:
      return undefined;
  }
}

function getPrimaryMediaValue(block: Record<string, unknown>): unknown {
  switch (block.type) {
    case 'image':
    case 'input_image':
    case 'output_image':
      return block.image;
    case 'audio':
      return block.audio;
    case 'input_file':
    case 'file':
      return block.file;
    default:
      return undefined;
  }
}

function getFileId(
  block: Record<string, unknown>,
  primary: Record<string, unknown> | undefined,
  source: Record<string, unknown> | undefined
): string | undefined {
  const directId = block.fileId ?? block.file_id;
  if (typeof directId === 'string' && directId) return directId;
  if (typeof primary?.id === 'string' && primary.id) return primary.id;
  if (typeof primary?.fileId === 'string' && primary.fileId) return primary.fileId;
  if (typeof source?.fileId === 'string' && source.fileId) return source.fileId;
  if (source && (source.type === 'id' || source.source_type === 'id') && typeof source.id === 'string' && source.id) {
    return source.id;
  }
  if (block.source_type === 'id' && typeof block.id === 'string' && block.id) return block.id;
  return undefined;
}

function buildAutoMediaPart(
  value: unknown,
  modality: string,
  mimeType: string | undefined,
  sources: Record<string, unknown>[],
  allowBase64: boolean
): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    if (typeof value.id === 'string' && value.id) {
      return withMediaMetadata(withOptionalMimeType({ type: 'file', modality, file_id: value.id }, mimeType), [
        ...sources,
        value,
      ]);
    }
    if (value.url !== undefined) {
      return buildAutoMediaPart(value.url, modality, mimeType, [...sources, value], false);
    }
    if (value.data !== undefined) {
      return buildBase64MediaPart(value.data, modality, mimeType, [...sources, value]);
    }
  }
  if (value instanceof URL) {
    return buildUriOrDataUrlPart(value.toString(), modality, mimeType, sources);
  }
  if (typeof value === 'string') {
    if (!value) return undefined;
    if (value.toLowerCase().startsWith('data:') || looksLikeUri(value)) {
      return buildUriOrDataUrlPart(value, modality, mimeType, sources);
    }
    return allowBase64 ? buildBlobPart(value, modality, mimeType, sources) : undefined;
  }
  const encodedBinary = binaryToBase64(value);
  return encodedBinary === undefined ? undefined : buildBlobPart(encodedBinary, modality, mimeType, sources);
}

function buildBase64MediaPart(
  value: unknown,
  modality: string,
  mimeType: string | undefined,
  sources: Record<string, unknown>[]
): Record<string, unknown> | undefined {
  if (value instanceof URL) {
    return buildUriOrDataUrlPart(value.toString(), modality, mimeType, sources);
  }
  if (typeof value === 'string') {
    return value ? buildBlobPart(value, modality, mimeType, sources) : undefined;
  }
  const encodedBinary = binaryToBase64(value);
  return encodedBinary === undefined ? undefined : buildBlobPart(encodedBinary, modality, mimeType, sources);
}

function buildUriOrDataUrlPart(
  value: string,
  modality: string,
  mimeType: string | undefined,
  sources: Record<string, unknown>[]
): Record<string, unknown> {
  const dataUrl = parseDataUrl(value);
  if (dataUrl) {
    const content = dataUrl.isBase64
      ? Buffer.from(dataUrl.data, 'base64').toString('base64')
      : percentEncodedDataToBuffer(dataUrl.data).toString('base64');
    return buildBlobPart(content, modality, dataUrl.mimeType ?? mimeType, sources);
  }
  return withMediaMetadata(withOptionalMimeType({ type: 'uri', modality, uri: value }, mimeType), sources);
}

function buildBlobPart(
  content: string,
  modality: string,
  mimeType: string | undefined,
  sources: Record<string, unknown>[]
): Record<string, unknown> {
  return withMediaMetadata(
    withOptionalMimeType(
      {
        type: 'blob',
        modality,
        content,
      },
      mimeType ?? defaultMimeType(modality)
    ),
    sources
  );
}

function parseDataUrl(value: string): { mimeType?: string; data: string; isBase64: boolean } | undefined {
  if (!value.toLowerCase().startsWith('data:')) return undefined;
  const commaIndex = value.indexOf(',');
  const header = commaIndex >= 0 ? value.slice(5, commaIndex) : value.slice(5);
  const data = commaIndex >= 0 ? value.slice(commaIndex + 1) : '';
  const tokens = header.split(';');
  const mimeType = tokens[0] || undefined;
  return {
    mimeType,
    data,
    isBase64: tokens.slice(1).some(token => token.toLowerCase() === 'base64'),
  };
}

function percentEncodedDataToBuffer(value: string): Buffer {
  const chunks: Buffer[] = [];
  let literalStart = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '%' || !/^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))) continue;
    if (literalStart < index) chunks.push(Buffer.from(value.slice(literalStart, index), 'utf8'));
    chunks.push(Buffer.from([parseInt(value.slice(index + 1, index + 3), 16)]));
    index += 2;
    literalStart = index + 1;
  }
  if (literalStart < value.length) chunks.push(Buffer.from(value.slice(literalStart), 'utf8'));
  return Buffer.concat(chunks);
}

function looksLikeUri(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function getMimeType(sources: Record<string, unknown>[], modality: string): string | undefined {
  for (const source of sources) {
    const mimeType = source.mimeType ?? source.mediaType ?? source.media_type ?? source.mime_type;
    if (typeof mimeType === 'string' && mimeType) return mimeType;
  }
  for (const source of sources) {
    if (typeof source.format === 'string' && source.format) {
      return modality === 'audio' ? `audio/${source.format}` : source.format;
    }
  }
  return undefined;
}

function defaultMimeType(modality: string): string | undefined {
  switch (modality) {
    case 'image':
      return 'image/*';
    case 'audio':
      return 'audio/*';
    case 'video':
      return 'video/*';
    case 'document':
      return 'application/octet-stream';
    case 'text':
      return 'text/plain';
    default:
      return undefined;
  }
}

function withOptionalMimeType(part: Record<string, unknown>, mimeType: string | undefined): Record<string, unknown> {
  return mimeType ? { ...part, mime_type: mimeType } : part;
}

function withMediaMetadata(part: Record<string, unknown>, sources: Record<string, unknown>[]): Record<string, unknown> {
  return copySelectedFields(part, sources, [
    'filename',
    'transcript',
    'format',
    'title',
    'context',
    'detail',
    'providerMetadata',
    'providerOptions',
    'providerData',
    'metadata',
  ]);
}

function copySelectedFields(
  target: Record<string, unknown>,
  sources: Record<string, unknown>[],
  fields: string[]
): Record<string, unknown> {
  const result = { ...target };
  for (const source of sources) {
    for (const field of fields) {
      if (result[field] === undefined && source[field] !== undefined) {
        result[field] = source[field];
      }
    }
  }
  return result;
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

export function normalizeFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':
    case 'STOP':
    case 'end_turn':
    case 'stop_sequence':
    case 'STOP_SEQUENCE':
    case 'COMPLETE':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
    case 'ERROR_LIMIT':
    case 'max_output_tokens':
      return 'length';
    case 'content_filter':
    case 'content_filtered':
    case 'content-filter':
    case 'SAFETY':
    case 'RECITATION':
    case 'ERROR_TOXIC':
    case 'refusal':
      return 'content_filter';
    case 'tool_use':
    case 'tool_calls':
    case 'function_call':
    case 'TOOL_CALL':
    case 'tool-calls':
      return 'tool_call';
    case 'error':
    case 'ERROR':
    case 'TIMEOUT':
    case 'failed':
      return 'error';
    default:
      return reason;
  }
}
