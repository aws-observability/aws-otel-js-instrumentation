// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  parseCaptureConfiguration,
  CAPTURE_DEFAULTS,
} from '../../../src/dynamic-instrumentation/model/capture-configuration';

describe('CaptureConfiguration', function () {
  it('should return defaults for null input', function () {
    const config = parseCaptureConfiguration(null);
    expect(config.maxStringLength).toBe(CAPTURE_DEFAULTS.maxStringLength);
    expect(config.maxObjectDepth).toBe(CAPTURE_DEFAULTS.maxObjectDepth);
    expect(config.captureReturn).toBe(false);
    expect(config.captureStackTrace).toBe(false);
  });

  it('should return defaults for empty object', function () {
    const config = parseCaptureConfiguration({});
    expect(config.maxStringLength).toBe(255);
    expect(config.maxCollectionWidth).toBe(20);
  });

  it('should unwrap CodeCapture union', function () {
    const config = parseCaptureConfiguration({
      CodeCapture: {
        CaptureReturn: true,
        CaptureLimits: { MaxStringLength: 100 },
      },
    });
    expect(config.captureReturn).toBe(true);
    expect(config.maxStringLength).toBe(100);
  });

  it('should default captureStackTrace to false', function () {
    const config = parseCaptureConfiguration({});
    expect(config.captureStackTrace).toBe(false);
  });

  it('should respect captureStackTrace=true when explicitly set', function () {
    const config = parseCaptureConfiguration({
      CaptureStackTrace: true,
    });
    expect(config.captureStackTrace).toBe(true);
  });

  it('should clamp values to min range', function () {
    const config = parseCaptureConfiguration({
      CaptureLimits: { MaxStringLength: 0, MaxObjectDepth: -5 },
    });
    expect(config.maxStringLength).toBe(1); // min is 1
    expect(config.maxObjectDepth).toBe(1); // min is 1
  });

  it('should clamp values to max range', function () {
    const config = parseCaptureConfiguration({
      CaptureLimits: { MaxStringLength: 99999, MaxObjectDepth: 100 },
    });
    expect(config.maxStringLength).toBe(255); // max is 255
    expect(config.maxObjectDepth).toBe(5); // max is 5
  });

  it('should parse CaptureArguments as string array', function () {
    const config = parseCaptureConfiguration({
      CaptureArguments: ['a', 'b', 'c'],
    });
    expect(config.captureArguments).toEqual(['a', 'b', 'c']);
  });

  it('should parse CaptureLocals as string array', function () {
    const config = parseCaptureConfiguration({
      CaptureLocals: ['x', 'y'],
    });
    expect(config.captureLocals).toEqual(['x', 'y']);
  });

  it('should handle invalid CaptureArguments type', function () {
    const config = parseCaptureConfiguration({
      CaptureArguments: 'not-an-array',
    });
    // Invalid type but key present -> [] (capture all)
    expect(config.captureArguments).toEqual([]);
  });

  it('should return null for missing CaptureLocals (do not capture)', function () {
    const config = parseCaptureConfiguration({
      CaptureReturn: true,
    });
    expect(config.captureLocals).toBeNull();
    expect(config.captureArguments).toBeNull();
  });

  it('should return empty array for present-but-empty CaptureLocals (capture all)', function () {
    const config = parseCaptureConfiguration({
      CaptureLocals: [],
      CaptureArguments: [],
    });
    expect(config.captureLocals).toEqual([]);
    expect(config.captureArguments).toEqual([]);
    expect(config.captureLocals).not.toBeNull();
    expect(config.captureArguments).not.toBeNull();
  });

  it('should handle mixed missing and present capture fields', function () {
    const config = parseCaptureConfiguration({
      CaptureLocals: [],
      // CaptureArguments intentionally missing
    });
    expect(config.captureLocals).toEqual([]);
    expect(config.captureLocals).not.toBeNull();
    expect(config.captureArguments).toBeNull();
  });

  it('should return null for defaults (no capture fields)', function () {
    const config = parseCaptureConfiguration({});
    expect(config.captureLocals).toBeNull();
    expect(config.captureArguments).toBeNull();
  });

  it('should handle NaN values gracefully', function () {
    const config = parseCaptureConfiguration({
      CaptureLimits: { MaxStringLength: 'abc' },
    });
    expect(config.maxStringLength).toBe(255); // default
  });

  it('should parse returnAttributeName', function () {
    const config = parseCaptureConfiguration({
      ReturnAttributeName: 'my.return',
    });
    expect(config.returnAttributeName).toBe('my.return');
  });

  it('should default returnAttributeName', function () {
    const config = parseCaptureConfiguration({});
    expect(config.returnAttributeName).toBe('aws.di.return_value');
  });
});
