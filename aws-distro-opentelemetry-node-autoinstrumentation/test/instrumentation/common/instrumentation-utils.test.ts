// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import {
  contentToParts,
  normalizeFinishReason,
  serializeToJson,
  toToolAttributeValue,
} from '../../../src/instrumentation/common/instrumentation-utils';
import { validateOtelGenaiSchema } from '../otel-schema-validator';

describe('serializeToJson', function () {
  it('handles circular references', function () {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = serializeToJson(obj);
    expect(result).toContain('[Circular]');
    expect(result).toContain('"a":1');
  });

  it('serializes normal objects', function () {
    const result = serializeToJson({ a: 1, b: [2, 3] });
    expect(result).toBe('{"a":1,"b":[2,3]}');
  });

  it('handles deeply nested objects within maxDepth', function () {
    const result = serializeToJson({ a: { b: { c: 1 } } }, 2);
    expect(result).toContain('"...');
  });

  it('handles null and undefined', function () {
    expect(serializeToJson(null)).toBe('null');
    expect(serializeToJson(undefined)).toBe('"undefined"');
    expect(serializeToJson(undefined)).not.toBe(serializeToJson(null));
  });

  it('handles arrays with circular references', function () {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    const result = serializeToJson(arr);
    expect(result).toContain('[Circular]');
  });

  it('converts non-serializable objects to strings', function () {
    const result = serializeToJson({ fn: () => 'hello', sym: Symbol('test') });
    const parsed = JSON.parse(result);
    expect(typeof parsed.fn).toBe('string');
    expect(typeof parsed.sym).toBe('string');
  });

  it('handles primitive types', function () {
    expect(serializeToJson('hello')).toBe('"hello"');
    expect(serializeToJson(42)).toBe('42');
    expect(serializeToJson(true)).toBe('true');
    expect(serializeToJson(false)).toBe('false');
  });

  it('handles empty objects and arrays', function () {
    expect(serializeToJson({})).toBe('{}');
    expect(serializeToJson([])).toBe('[]');
  });

  it('handles nested arrays and objects', function () {
    const result = serializeToJson({ a: [{ b: [1, 2] }, { c: 3 }] });
    expect(result).toBe('{"a":[{"b":[1,2]},{"c":3}]}');
  });

  it('handles objects with class instances', function () {
    class Foo {
      x: number = 1;
      y: string = 'bar';
    }
    const result = serializeToJson({ item: new Foo() });
    const parsed = JSON.parse(result);
    expect(parsed.item.x).toBe(1);
    expect(parsed.item.y).toBe('bar');
  });

  it('truncates at maxDepth=0', function () {
    const result = serializeToJson({ a: 1 }, 0);
    expect(result).toBe('"..."');
  });

  it('base64-encodes binary values', function () {
    const result = serializeToJson({
      buffer: Buffer.from('hello'),
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(JSON.parse(result)).toEqual({
      buffer: 'aGVsbG8=',
      bytes: 'AQID',
    });
  });

  it('sanitizes Date, Error, Map, and Set values', function () {
    const error = new TypeError('bad input');
    const result = JSON.parse(
      serializeToJson({
        date: new Date('2026-08-18T12:00:00.000Z'),
        error,
        map: new Map([
          ['one', 1],
          ['two', 2],
        ]),
        set: new Set(['a', 'b']),
      })
    );
    expect(result).toEqual({
      date: '2026-08-18T12:00:00.000Z',
      error: {
        name: 'TypeError',
        message: 'bad input',
        stack: error.stack,
      },
      map: [
        ['one', 1],
        ['two', 2],
      ],
      set: ['a', 'b'],
    });
  });

  it('serializes shared aliases without marking them circular', function () {
    const shared = { value: 1 };
    expect(JSON.parse(serializeToJson({ first: shared, second: shared }))).toEqual({
      first: { value: 1 },
      second: { value: 1 },
    });
  });

  it('uses a constant terminal fallback without coercing the user object', function () {
    let primitiveCalled = false;
    let toStringCalled = false;
    const value = new Proxy(
      {
        [Symbol.toPrimitive]: () => {
          primitiveCalled = true;
          throw new Error('do not coerce');
        },
        toString: () => {
          toStringCalled = true;
          throw new Error('do not stringify');
        },
      },
      {
        ownKeys: () => {
          throw new Error('cannot inspect');
        },
      }
    );

    expect(serializeToJson(value)).toBe('"[Unserializable]"');
    expect(primitiveCalled).toBe(false);
    expect(toStringCalled).toBe(false);
  });
});

describe('toToolAttributeValue', function () {
  it('keeps primitive values native', function () {
    expect(toToolAttributeValue('')).toBe('');
    expect(toToolAttributeValue('result')).toBe('result');
    expect(toToolAttributeValue(42)).toBe(42);
    expect(toToolAttributeValue(true)).toBe(true);
    expect(toToolAttributeValue(null)).toBe('null');
    expect(toToolAttributeValue(undefined)).toBeUndefined();
  });

  it('serializes structured and binary values', function () {
    expect(toToolAttributeValue({ result: 3 })).toBe('{"result":3}');
    expect(toToolAttributeValue(Buffer.from('hello'))).toBe('aGVsbG8=');
  });
});

describe('contentToParts', function () {
  it('maps refusal and typeless blocks to generic parts without losing fields', async function () {
    const parts = contentToParts([
      { type: 'refusal', refusal: 'I cannot do that.' },
      { payload: { answer: 42 }, label: 'structured' },
    ]);
    expect(parts).toEqual([
      { type: 'refusal', refusal: 'I cannot do that.' },
      { type: 'unknown', payload: { answer: 42 }, label: 'structured' },
    ]);
    await validateOtelGenaiSchema([{ role: 'assistant', parts, finish_reason: 'stop' }], 'gen-ai-output-messages');
  });

  it('maps multimodal and reasoning blocks to exact typed parts', async function () {
    const parts = contentToParts([
      { type: 'text', text: 'describe' },
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(parts).toEqual([
      { type: 'text', content: 'describe' },
      { type: 'reasoning', content: 'reasoning' },
      { type: 'uri', modality: 'image', uri: 'https://example.com/cat.png' },
      { type: 'blob', modality: 'image', mime_type: 'image/png', content: 'AAAA' },
    ]);
    await validateOtelGenaiSchema([{ role: 'user', parts }], 'gen-ai-input-messages');
  });

  it('converts percent-encoded and case-insensitive base64 data URLs to canonical blobs', function () {
    expect(
      contentToParts([
        { type: 'image', image: 'data:image/svg+xml,%3Csvg%3E' },
        { type: 'image', image: 'data:application/octet-stream,%FF' },
        { type: 'image', image: 'data:image/png;BASE64,AAAA' },
      ])
    ).toEqual([
      { type: 'blob', modality: 'image', mime_type: 'image/svg+xml', content: 'PHN2Zz4=' },
      { type: 'blob', modality: 'image', mime_type: 'application/octet-stream', content: '/w==' },
      { type: 'blob', modality: 'image', mime_type: 'image/png', content: 'AAAA' },
    ]);
  });

  it('uses field contracts for base64, URLs, binary data, and file IDs', function () {
    expect(
      contentToParts([
        { type: 'file', data: 'https://base64-by-contract.example', mediaType: 'application/pdf' },
        { type: 'file', data: new URL('https://example.com/report.pdf'), mediaType: 'application/pdf' },
        { type: 'image', image: { id: 'image-file' } },
        { type: 'input_file', file: { id: 'document-file' }, filename: 'report.pdf' },
        { type: 'audio', audio: { id: 'audio-file' }, format: 'mp3' },
        { type: 'image', source_type: 'id', id: 'legacy-file' },
        { type: 'image', id: 'block-id', data: Buffer.from('image'), mimeType: 'image/png' },
      ])
    ).toEqual([
      {
        type: 'blob',
        modality: 'document',
        content: 'https://base64-by-contract.example',
        mime_type: 'application/pdf',
      },
      {
        type: 'uri',
        modality: 'document',
        uri: 'https://example.com/report.pdf',
        mime_type: 'application/pdf',
      },
      { type: 'file', modality: 'image', file_id: 'image-file' },
      { type: 'file', modality: 'document', file_id: 'document-file', filename: 'report.pdf' },
      { type: 'file', modality: 'audio', file_id: 'audio-file', mime_type: 'audio/mp3', format: 'mp3' },
      { type: 'file', modality: 'image', file_id: 'legacy-file' },
      { type: 'blob', modality: 'image', content: 'aW1hZ2U=', mime_type: 'image/png' },
    ]);
  });

  it('normalizes audio, file, video, text, and camelCase MIME metadata', function () {
    expect(
      contentToParts([
        {
          type: 'input_audio',
          input_audio: { data: 'AAAA', format: 'wav' },
          transcript: 'hello',
          providerData: { request: 'audio' },
        },
        { type: 'input_file', file_data: 'BBBB', filename: 'notes.txt', mimeType: 'text/plain' },
        { type: 'video', data: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4' },
        {
          type: 'text-plain',
          text: 'inline text',
          title: 'Title',
          context: 'Context',
          providerMetadata: { provider: { id: 'text-1' } },
        },
        { type: 'text-plain', data: 'dGV4dA==', mimeType: 'text/plain' },
      ])
    ).toEqual([
      {
        type: 'blob',
        modality: 'audio',
        content: 'AAAA',
        mime_type: 'audio/wav',
        transcript: 'hello',
        format: 'wav',
        providerData: { request: 'audio' },
      },
      {
        type: 'blob',
        modality: 'document',
        content: 'BBBB',
        mime_type: 'text/plain',
        filename: 'notes.txt',
      },
      { type: 'blob', modality: 'video', content: 'AQID', mime_type: 'video/mp4' },
      {
        type: 'text',
        content: 'inline text',
        title: 'Title',
        context: 'Context',
        providerMetadata: { provider: { id: 'text-1' } },
      },
      { type: 'blob', modality: 'text', content: 'dGV4dA==', mime_type: 'text/plain' },
    ]);
  });

  it('returns the exact safe fallback for exceptional content', function () {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwingType = Object.defineProperty({}, 'type', {
      get() {
        throw new Error('cannot read type');
      },
    });

    expect(contentToParts(revoked.proxy)).toEqual([{ type: 'text', content: '[Unserializable]' }]);
    expect(contentToParts(throwingType)).toEqual([{ type: 'text', content: '[Unserializable]' }]);
  });
});

describe('normalizeFinishReason', function () {
  it('canonicalizes known reasons and preserves ambiguous values', function () {
    expect(
      [
        'stop',
        'end_turn',
        'stop_sequence',
        'STOP_SEQUENCE',
        'COMPLETE',
        'length',
        'max_tokens',
        'MAX_TOKENS',
        'ERROR_LIMIT',
        'content_filter',
        'content_filtered',
        'SAFETY',
        'RECITATION',
        'ERROR_TOXIC',
        'refusal',
        'tool_use',
        'tool_calls',
        'function_call',
        'TOOL_CALL',
        'error',
        'ERROR',
        'TIMEOUT',
        'pause_turn',
        'USER_CANCEL',
      ].map(normalizeFinishReason)
    ).toEqual([
      'stop',
      'stop',
      'stop',
      'stop',
      'stop',
      'length',
      'length',
      'length',
      'length',
      'content_filter',
      'content_filter',
      'content_filter',
      'content_filter',
      'content_filter',
      'content_filter',
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_call',
      'error',
      'error',
      'error',
      'pause_turn',
      'USER_CANCEL',
    ]);
  });
});
