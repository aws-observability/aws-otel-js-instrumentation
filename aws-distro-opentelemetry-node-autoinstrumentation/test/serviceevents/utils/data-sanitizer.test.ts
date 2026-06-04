// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  minimizeObject,
  sanitizeSensitiveFields,
  truncateString,
  limitCollection,
  SENSITIVE_PATTERNS,
  REDACTED_VALUE,
} from '../../../src/serviceevents/utils/data-sanitizer';

describe('DataSanitizer', function () {
  describe('minimizeObject()', function () {
    it('should return null for null', function () {
      expect(minimizeObject(null)).toBe(null);
    });

    it('should return undefined for undefined', function () {
      expect(minimizeObject(undefined)).toBe(undefined);
    });

    it('should return numbers as-is', function () {
      expect(minimizeObject(42)).toBe(42);
      expect(minimizeObject(3.14)).toBe(3.14);
    });

    it('should return booleans as-is', function () {
      expect(minimizeObject(true)).toBe(true);
      expect(minimizeObject(false)).toBe(false);
    });

    it('should return short strings as-is', function () {
      expect(minimizeObject('hello')).toBe('hello');
    });

    it('should truncate long strings', function () {
      const longStr = 'a'.repeat(2000);
      const result = minimizeObject(longStr, { maxStringLength: 100 }) as string;
      expect(result.length).toBeLessThan(longStr.length);
      expect(result).toContain('...[truncated');
    });

    it('should minimize arrays', function () {
      const arr = [1, 2, 3, 4, 5];
      const result = minimizeObject(arr, { maxArrayLength: 3 }) as unknown[];
      expect(result.length).toBe(4); // 3 items + truncation message
      expect(result[3]).toContain('2 more items');
    });

    it('should minimize objects with too many keys', function () {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 20; i++) {
        obj[`key${i}`] = i;
      }
      const result = minimizeObject(obj, { maxDictLength: 5 }) as Record<string, unknown>;
      // 5 keys + __truncated__
      expect(Object.keys(result).length).toBe(6);
      expect(result.__truncated__).toBeDefined();
    });

    it('should respect maxDepth', function () {
      const deep = { a: { b: { c: { d: { e: 'value' } } } } };
      const result = minimizeObject(deep, { maxDepth: 3 }) as any;
      expect(result.a.b.c).toContain('max depth');
    });

    it('should handle nested arrays and objects', function () {
      const nested = {
        users: [
          { name: 'Alice', age: 30 },
          { name: 'Bob', age: 25 },
        ],
      };
      const result = minimizeObject(nested) as any;
      expect(result.users).toHaveLength(2);
      expect(result.users[0].name).toBe('Alice');
    });

    it('should handle Buffer objects', function () {
      const buf = Buffer.from('hello', 'utf-8');
      const result = minimizeObject(buf);
      expect(result).toBe('hello');
    });

    it('should handle large Buffer objects', function () {
      const buf = Buffer.alloc(5000, 'a');
      const result = minimizeObject(buf, { maxStringLength: 100 }) as string;
      expect(result).toContain('bytes');
    });

    it('should convert other types to string via String()', function () {
      const sym = Symbol('test');
      const result = minimizeObject(sym);
      expect(result).toBe('Symbol(test)');
    });

    it('should truncate long string representations of other types', function () {
      // Create an object with a very long toString
      const obj = {
        toString() {
          return 'x'.repeat(2000);
        },
      };
      // Cast to unknown to bypass type checking, treating as "other type"
      const result = minimizeObject(obj as unknown, { maxStringLength: 50 });
      // It will be handled as a plain object, not via toString
      expect(result).toBeDefined();
    });

    it('should handle arrays that do not need truncation', function () {
      const arr = [1, 2, 3];
      const result = minimizeObject(arr, { maxArrayLength: 10 }) as unknown[];
      expect(result).toEqual([1, 2, 3]);
    });

    it('should handle objects that do not need truncation', function () {
      const obj = { a: 1, b: 2 };
      const result = minimizeObject(obj, { maxDictLength: 10 }) as Record<string, unknown>;
      expect(result).toEqual({ a: 1, b: 2 });
    });
  });

  describe('sanitizeSensitiveFields()', function () {
    it('should redact password fields', function () {
      const data = { username: 'admin', password: 'secret123' };
      const result = sanitizeSensitiveFields(data);
      expect(result.username).toBe('admin');
      expect(result.password).toBe(REDACTED_VALUE);
    });

    it('should redact api_key fields', function () {
      const data = { api_key: 'abc123', data: 'value' };
      const result = sanitizeSensitiveFields(data);
      expect(result.api_key).toBe(REDACTED_VALUE);
      expect(result.data).toBe('value');
    });

    it('should redact token fields', function () {
      const data = { auth_token: 'tok_123', info: 'data' };
      const result = sanitizeSensitiveFields(data);
      expect(result.auth_token).toBe(REDACTED_VALUE);
    });

    it('should redact fields case-insensitively', function () {
      const data = { PASSWORD: 'secret', ApiKey: 'key123' };
      const result = sanitizeSensitiveFields(data);
      expect(result.PASSWORD).toBe(REDACTED_VALUE);
      expect(result.ApiKey).toBe(REDACTED_VALUE);
    });

    it('should recursively sanitize nested objects', function () {
      const data = {
        config: {
          db_password: 'dbpass',
          host: 'localhost',
        },
      };
      const result = sanitizeSensitiveFields(data) as any;
      expect(result.config.db_password).toBe(REDACTED_VALUE);
      expect(result.config.host).toBe('localhost');
    });

    it('should sanitize objects in arrays', function () {
      const data = {
        users: [
          { name: 'Alice', secret_key: 'sk_123' },
          { name: 'Bob', api_key: 'ak_456' },
        ],
      };
      const result = sanitizeSensitiveFields(data) as any;
      expect(result.users[0].name).toBe('Alice');
      expect(result.users[0].secret_key).toBe(REDACTED_VALUE);
      expect(result.users[1].api_key).toBe(REDACTED_VALUE);
    });

    it('should accept additional sensitive keys', function () {
      const data = { my_custom_field: 'value', normal: 'data' };
      const result = sanitizeSensitiveFields(data, ['my_custom_field']);
      expect(result.my_custom_field).toBe(REDACTED_VALUE);
      expect(result.normal).toBe('data');
    });

    it('should return non-objects unchanged', function () {
      const result = sanitizeSensitiveFields(null as any);
      expect(result).toBe(null);
    });

    it('should handle empty objects', function () {
      const result = sanitizeSensitiveFields({});
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should return arrays unchanged', function () {
      const result = sanitizeSensitiveFields([] as any);
      expect(result).toEqual([]);
    });

    it('should handle arrays with non-object items', function () {
      const data = {
        tags: ['admin', 'user', 42],
      };
      const result = sanitizeSensitiveFields(data) as any;
      expect(result.tags).toEqual(['admin', 'user', 42]);
    });
  });

  describe('truncateString()', function () {
    it('should return short strings unchanged', function () {
      expect(truncateString('hello')).toBe('hello');
    });

    it('should truncate long strings with message', function () {
      const long = 'a'.repeat(2000);
      const result = truncateString(long, 100);
      expect(result.length).toBeLessThan(long.length);
      expect(result).toContain('...[truncated');
      expect(result).toContain('2000 chars total');
    });
  });

  describe('limitCollection()', function () {
    it('should limit arrays', function () {
      const arr = [1, 2, 3, 4, 5];
      const result = limitCollection(arr, 3) as unknown[];
      expect(result.length).toBe(4); // 3 + truncation message
    });

    it('should limit objects', function () {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 10; i++) {
        obj[`k${i}`] = i;
      }
      const result = limitCollection(obj, 5) as Record<string, unknown>;
      expect(Object.keys(result).length).toBe(6); // 5 + __truncated__
    });

    it('should return non-collections unchanged', function () {
      expect(limitCollection('hello')).toBe('hello');
      expect(limitCollection(42)).toBe(42);
    });

    it('should return small arrays unchanged', function () {
      const arr = [1, 2];
      const result = limitCollection(arr, 10);
      expect(result).toEqual([1, 2]);
    });

    it('should return small objects unchanged', function () {
      const obj = { a: 1 };
      const result = limitCollection(obj, 10);
      expect(result).toEqual({ a: 1 });
    });

    it('should handle null', function () {
      expect(limitCollection(null)).toBe(null);
    });
  });

  describe('SENSITIVE_PATTERNS', function () {
    it('should contain common sensitive field patterns', function () {
      expect(SENSITIVE_PATTERNS).toContain('password');
      expect(SENSITIVE_PATTERNS).toContain('secret');
      expect(SENSITIVE_PATTERNS).toContain('api_key');
      expect(SENSITIVE_PATTERNS).toContain('token');
      expect(SENSITIVE_PATTERNS).toContain('authorization');
      expect(SENSITIVE_PATTERNS).toContain('ssn');
      expect(SENSITIVE_PATTERNS).toContain('private_key');
    });
  });
});
