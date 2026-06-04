// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { serializeValue } from '../../src/dynamic-instrumentation/value-serializer';
import { CAPTURE_DEFAULTS } from '../../src/dynamic-instrumentation/model/capture-configuration';
import { CaptureConfiguration } from '../../src/dynamic-instrumentation/model/capture-configuration';

const defaults = CAPTURE_DEFAULTS as CaptureConfiguration;

function withLimits(overrides: Partial<CaptureConfiguration> = {}): CaptureConfiguration {
  return { ...defaults, ...overrides };
}

describe('serializeValue', function () {
  describe('primitives', function () {
    it('should serialize null', function () {
      const result = serializeValue(null);
      expect(result.type).toBe('null');
      expect(result.isNull).toBe(true);
    });

    it('should serialize undefined', function () {
      const result = serializeValue(undefined);
      expect(result.type).toBe('undefined');
      expect(result.value).toBe('undefined');
    });

    it('should serialize string', function () {
      const result = serializeValue('hello');
      expect(result.type).toBe('string');
      expect(result.value).toBe('hello');
    });

    it('should serialize number', function () {
      const result = serializeValue(42);
      expect(result.type).toBe('number');
      expect(result.value).toBe('42');
    });

    it('should serialize float', function () {
      const result = serializeValue(3.14);
      expect(result.type).toBe('number');
      expect(result.value).toBe('3.14');
    });

    it('should serialize boolean', function () {
      expect(serializeValue(true).value).toBe('true');
      expect(serializeValue(false).value).toBe('false');
    });

    it('should serialize bigint', function () {
      const result = serializeValue(BigInt(9007199254740991));
      expect(result.type).toBe('bigint');
      expect(result.value).toBe('9007199254740991');
    });

    it('should serialize symbol', function () {
      const result = serializeValue(Symbol('test'));
      expect(result.type).toBe('symbol');
      expect(result.value).toContain('test');
    });

    it('should serialize function', function () {
      const result = serializeValue(function myFunc() {});
      expect(result.type).toBe('function');
      expect(result.value).toContain('myFunc');
    });
  });

  describe('string limits', function () {
    it('should not truncate short strings', function () {
      const result = serializeValue('short', withLimits({ maxStringLength: 10 }));
      expect(result.value).toBe('short');
      expect(result.truncated).toBeUndefined();
    });

    it('should truncate long strings', function () {
      const result = serializeValue('a'.repeat(300), withLimits({ maxStringLength: 10 }));
      expect(result.value).toBe('a'.repeat(10));
      expect(result.truncated).toBe(true);
      expect(result.size).toBe(300);
    });
  });

  describe('arrays', function () {
    it('should serialize simple array', function () {
      const result = serializeValue([1, 2, 3]);
      expect(result.type).toBe('Array');
      expect(result.elements).toHaveLength(3);
      expect(result.elements![0].value).toBe('1');
      expect(result.size).toBe(3);
    });

    it('should truncate large arrays', function () {
      const arr = Array.from({ length: 100 }, (_, i) => i);
      const result = serializeValue(arr, withLimits({ maxCollectionWidth: 5 }));
      expect(result.elements).toHaveLength(5);
      expect(result.truncated).toBe(true);
      expect(result.size).toBe(100);
    });

    it('should serialize empty array', function () {
      const result = serializeValue([]);
      expect(result.type).toBe('Array');
      expect(result.elements).toHaveLength(0);
      expect(result.size).toBe(0);
    });
  });

  describe('objects', function () {
    it('should serialize plain object', function () {
      const result = serializeValue({ a: 1, b: 'hello' });
      expect(result.type).toBe('Object');
      expect(result.fields).toBeDefined();
      expect(result.fields!.a.value).toBe('1');
      expect(result.fields!.b.value).toBe('hello');
    });

    it('should truncate objects with many fields', function () {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 50; i++) obj[`key${i}`] = i;
      const result = serializeValue(obj, withLimits({ maxFieldsPerObject: 5 }));
      expect(Object.keys(result.fields!)).toHaveLength(5);
      expect(result.truncated).toBe(true);
      expect(result.size).toBe(50);
    });

    it('should serialize nested objects', function () {
      const result = serializeValue({ a: { b: { c: 42 } } });
      expect(result.fields!.a.fields!.b.fields!.c.value).toBe('42');
    });

    it('should enforce depth limit', function () {
      const deep = { a: { b: { c: { d: 'too deep' } } } };
      const result = serializeValue(deep, withLimits({ maxObjectDepth: 2 }));
      // depth 0=root, 1=a, 2=b, 3=c exceeds maxObjectDepth=2
      expect(result.fields!.a.fields!.b.fields!.c.notCapturedReason).toBe('depth');
    });

    it('should serialize empty object', function () {
      const result = serializeValue({});
      expect(result.type).toBe('Object');
      expect(result.fields).toBeDefined();
      expect(Object.keys(result.fields!)).toHaveLength(0);
    });
  });

  describe('Maps', function () {
    it('should serialize Map', function () {
      const map = new Map([
        ['key1', 'val1'],
        ['key2', 'val2'],
      ]);
      const result = serializeValue(map);
      expect(result.type).toBe('Map');
      expect(result.entries).toBeDefined();
      expect(result.entries).toHaveLength(2);
      expect(result.size).toBe(2);
    });

    it('should truncate large Maps', function () {
      const map = new Map<string, number>();
      for (let i = 0; i < 50; i++) map.set(`k${i}`, i);
      const result = serializeValue(map, withLimits({ maxCollectionWidth: 3 }));
      expect(result.entries).toHaveLength(3);
      expect(result.truncated).toBe(true);
    });
  });

  describe('Sets', function () {
    it('should serialize Set', function () {
      const result = serializeValue(new Set([1, 2, 3]));
      expect(result.type).toBe('Set');
      expect(result.elements).toHaveLength(3);
      expect(result.size).toBe(3);
    });

    it('should truncate large Sets', function () {
      const set = new Set(Array.from({ length: 50 }, (_, i) => i));
      const result = serializeValue(set, withLimits({ maxCollectionWidth: 2 }));
      expect(result.elements).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });
  });

  describe('special types', function () {
    it('should serialize Date', function () {
      const result = serializeValue(new Date('2026-01-01'));
      expect(result.type).toBe('Date');
      expect(result.value).toContain('2026');
    });

    it('should serialize RegExp', function () {
      const result = serializeValue(/test-\d+/gi);
      expect(result.type).toBe('RegExp');
      expect(result.value).toContain('test');
    });

    it('should serialize Error', function () {
      const result = serializeValue(new Error('test error'));
      expect(result.type).toBe('Error');
      expect(result.fields!.message.value).toBe('test error');
    });

    it('should serialize Buffer', function () {
      const result = serializeValue(Buffer.from('hello'));
      expect(result.type).toBe('Buffer');
      expect(result.value).toBeDefined();
      expect(result.size).toBe(5);
    });

    it('should serialize Promise as placeholder', function () {
      const result = serializeValue(Promise.resolve(42));
      expect(result.type).toBe('Promise');
      expect(result.value).toBe('<pending>');
    });

    it('should handle WeakMap', function () {
      const result = serializeValue(new WeakMap());
      expect(result.notCapturedReason).toBe('collectionSize');
    });

    it('should handle WeakSet', function () {
      const result = serializeValue(new WeakSet());
      expect(result.notCapturedReason).toBe('collectionSize');
    });
  });

  describe('circular references', function () {
    it('should detect circular reference', function () {
      const obj: any = { name: 'circular' };
      obj.self = obj;
      const result = serializeValue(obj);
      expect(result.fields!.name.value).toBe('circular');
      expect(result.fields!.self.notCapturedReason).toBe('circular');
    });

    it('should detect deep circular reference', function () {
      const a: any = { name: 'a' };
      const b: any = { name: 'b', ref: a };
      a.ref = b;
      const result = serializeValue(a);
      expect(result.fields!.ref.fields!.ref.notCapturedReason).toBe('circular');
    });
  });

  describe('timeout', function () {
    it('should return timeout for expired deadline', function () {
      const result = serializeValue({ a: 1 }, defaults, Date.now() - 1000);
      expect(result.notCapturedReason).toBe('timeout');
    });
  });
});
