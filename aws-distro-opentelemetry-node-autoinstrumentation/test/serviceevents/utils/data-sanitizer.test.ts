// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { truncateString } from '../../../src/serviceevents/utils/data-sanitizer';

describe('DataSanitizer', function () {
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
});
