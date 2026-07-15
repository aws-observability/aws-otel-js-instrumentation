// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  parseInstrumentationConfiguration,
  computeRegistryKey,
  isLineLevel,
  isPermanent,
} from '../../../src/dynamic-instrumentation/model/instrumentation-configuration';
import { InstrumentationType } from '../../../src/dynamic-instrumentation/model/types';

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    InstrumentationType: 'BREAKPOINT',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'javascript',
        MethodName: 'myFunc',
        FilePath: 'src/app.js',
        LineNumber: 10,
      },
    },
    LocationHash: 'abc123',
    ExpiresAt: '2099-12-31T23:59:59Z',
    CaptureConfiguration: { CodeCapture: { CaptureLimits: {} } },
    AttributeFilters: [],
    ...overrides,
  };
}

describe('parseInstrumentationConfiguration', function () {
  it('should parse a valid BREAKPOINT config', function () {
    const config = parseInstrumentationConfiguration(makeConfig());
    expect(config).not.toBeNull();
    expect(config!.instrumentationType).toBe(InstrumentationType.BREAKPOINT);
    expect(config!.methodName).toBe('myFunc');
    expect(config!.filePath).toBe('src/app.js');
    expect(config!.lineNumber).toBe(10);
    expect(config!.locationHash).toBe('abc123');
  });

  it('should parse a valid PROBE config', function () {
    const config = parseInstrumentationConfiguration(
      makeConfig({
        InstrumentationType: 'PROBE',
        Location: {
          CodeLocation: { Language: 'javascript', MethodName: 'myFunc', FilePath: 'app.js', LineNumber: 5 },
        },
      })
    );
    expect(config).not.toBeNull();
    expect(config!.instrumentationType).toBe(InstrumentationType.PROBE);
    expect(config!.lineNumber).toBe(0); // PROBE forces lineNumber to 0
    expect(config!.maxHits).toBe(Number.MAX_SAFE_INTEGER); // PROBE = unlimited
  });

  it('should reject config without FilePath', function () {
    const config = parseInstrumentationConfiguration(
      makeConfig({
        Location: { CodeLocation: { Language: 'javascript', MethodName: 'fn', FilePath: '', LineNumber: 1 } },
      })
    );
    expect(config).toBeNull();
  });

  it('should reject config without Location', function () {
    const config = parseInstrumentationConfiguration(makeConfig({ Location: null }));
    expect(config).toBeNull();
  });

  it('should reject non-JavaScript language', function () {
    const config = parseInstrumentationConfiguration(
      makeConfig({
        Location: { CodeLocation: { Language: 'python', MethodName: 'fn', FilePath: 'app.py', LineNumber: 1 } },
      })
    );
    expect(config).toBeNull();
  });

  it('should accept various JS language strings', function () {
    for (const lang of ['javascript', 'JavaScript', 'nodejs', 'node.js', 'node', 'js']) {
      const config = parseInstrumentationConfiguration(
        makeConfig({
          Location: { CodeLocation: { Language: lang, MethodName: 'fn', FilePath: 'app.js', LineNumber: 1 } },
        })
      );
      expect(config).not.toBeNull();
    }
  });

  it('should reject negative lineNumber', function () {
    const config = parseInstrumentationConfiguration(
      makeConfig({
        Location: { CodeLocation: { Language: 'javascript', MethodName: 'fn', FilePath: 'app.js', LineNumber: -1 } },
      })
    );
    expect(config).toBeNull();
  });

  it('should reject method-level BREAKPOINT without MethodName', function () {
    const config = parseInstrumentationConfiguration(
      makeConfig({
        Location: { CodeLocation: { Language: 'javascript', MethodName: '', FilePath: 'app.js', LineNumber: 0 } },
      })
    );
    expect(config).toBeNull();
  });

  it('should default InstrumentationType to BREAKPOINT', function () {
    const config = parseInstrumentationConfiguration(makeConfig({ InstrumentationType: undefined }));
    expect(config).not.toBeNull();
    expect(config!.instrumentationType).toBe(InstrumentationType.BREAKPOINT);
  });

  it('should clamp maxHits for BREAKPOINT', function () {
    const config = parseInstrumentationConfiguration(
      makeConfig({
        CaptureConfiguration: { CodeCapture: { CaptureLimits: { MaxHits: 9999 } } },
      })
    );
    expect(config).not.toBeNull();
    expect(config!.maxHits).toBe(1000); // max is 1000
  });

  it('should parse ExpiresAt for BREAKPOINT', function () {
    const config = parseInstrumentationConfiguration(makeConfig({ ExpiresAt: '2026-01-01T00:00:00Z' }));
    expect(config).not.toBeNull();
    expect(config!.expiresAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('should parse numeric epoch-seconds ExpiresAt as milliseconds for BREAKPOINT', function () {
    // The Application Signals API serializes ExpiresAt as numeric epoch seconds
    // over the JSON protocol. It must be converted to milliseconds so it can be
    // compared against Date.now(); otherwise the breakpoint is treated as expired.
    const epochSeconds = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000);
    const config = parseInstrumentationConfiguration(makeConfig({ ExpiresAt: epochSeconds }));
    expect(config).not.toBeNull();
    expect(config!.expiresAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('should pass through numeric millisecond ExpiresAt unchanged for BREAKPOINT', function () {
    const epochMillis = Date.parse('2026-01-01T00:00:00Z');
    const config = parseInstrumentationConfiguration(makeConfig({ ExpiresAt: epochMillis }));
    expect(config).not.toBeNull();
    expect(config!.expiresAt).toBe(epochMillis);
  });

  it('should ignore ExpiresAt for PROBE', function () {
    const config = parseInstrumentationConfiguration(
      makeConfig({
        InstrumentationType: 'PROBE',
        ExpiresAt: '2026-01-01T00:00:00Z',
      })
    );
    expect(config).not.toBeNull();
    expect(config!.expiresAt).toBeNull();
  });

  it('should parse AttributeFilters', function () {
    const config = parseInstrumentationConfiguration(makeConfig({ AttributeFilters: [{ 'service.name': 'my-svc' }] }));
    expect(config).not.toBeNull();
    expect(config!.attributeFilters).toEqual([{ 'service.name': 'my-svc' }]);
  });

  it('should return null for malformed input', function () {
    expect(parseInstrumentationConfiguration({} as any)).toBeNull();
    expect(parseInstrumentationConfiguration(null as any)).toBeNull();
  });
});

describe('computeRegistryKey', function () {
  it('should produce filePath:methodName:lineNumber format', function () {
    const config = parseInstrumentationConfiguration(makeConfig())!;
    expect(computeRegistryKey(config)).toBe('src/app.js:myFunc:10');
  });
});

describe('isLineLevel', function () {
  it('should return true for lineNumber > 0', function () {
    const config = parseInstrumentationConfiguration(makeConfig())!;
    expect(isLineLevel(config)).toBe(true);
  });

  it('should return false for lineNumber = 0', function () {
    const config = parseInstrumentationConfiguration(
      makeConfig({
        InstrumentationType: 'PROBE',
        Location: { CodeLocation: { Language: 'javascript', MethodName: 'fn', FilePath: 'a.js', LineNumber: 0 } },
      })
    )!;
    expect(isLineLevel(config)).toBe(false);
  });
});

describe('isPermanent', function () {
  it('should return true for PROBE', function () {
    const config = parseInstrumentationConfiguration(
      makeConfig({
        InstrumentationType: 'PROBE',
      })
    )!;
    expect(isPermanent(config)).toBe(true);
  });

  it('should return false for BREAKPOINT', function () {
    const config = parseInstrumentationConfiguration(makeConfig())!;
    expect(isPermanent(config)).toBe(false);
  });
});
