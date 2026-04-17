// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import { serializeToJson } from '../../../src/instrumentation/common/instrumentation-utils';

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
      x = 1;
      y = 'bar';
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
});
