// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import {
  contentToParts,
  serializeToJson,
  toToolAttributeValue,
} from '../../../src/instrumentation/common/instrumentation-utils';

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
    expect(serializeToJson(undefined)).toBe(undefined as unknown as string);
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
});

describe('toToolAttributeValue', function () {
  it('keeps primitive values native', function () {
    expect(toToolAttributeValue('')).toBe('');
    expect(toToolAttributeValue('result')).toBe('result');
    expect(toToolAttributeValue(42)).toBe(42);
    expect(toToolAttributeValue(true)).toBe(true);
    expect(toToolAttributeValue(null)).toBeUndefined();
    expect(toToolAttributeValue(undefined)).toBeUndefined();
  });

  it('serializes structured and binary values', function () {
    expect(toToolAttributeValue({ result: 3 })).toBe('{"result":3}');
    expect(toToolAttributeValue(Buffer.from('hello'))).toBe('aGVsbG8=');
  });

  it('omits values that cannot be serialized', function () {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(toToolAttributeValue(revoked.proxy)).toBeUndefined();
  });
});

describe('contentToParts', function () {
  it('preserves unrecognized and typeless blocks', function () {
    const parts = contentToParts([
      { type: 'refusal', refusal: 'I cannot do that.' },
      { payload: { answer: 42 }, label: 'structured' },
    ]);
    expect(parts).toEqual([
      { type: 'refusal', refusal: 'I cannot do that.' },
      { type: 'text', payload: { answer: 42 }, label: 'structured' },
    ]);
  });

  it('maps multimodal and reasoning blocks to typed parts', function () {
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
  });

  it('keeps binary image data for JSON base64 serialization', function () {
    const parts = contentToParts([{ type: 'image', media_type: 'image/png', data: Buffer.from('image') }]);
    expect(JSON.parse(serializeToJson(parts))).toEqual([
      { type: 'blob', modality: 'image', mime_type: 'image/png', content: 'aW1hZ2U=' },
    ]);
  });
});
