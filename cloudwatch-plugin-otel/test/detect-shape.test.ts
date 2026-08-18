// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import { detectShape } from '../src/internal/detect-shape';

// Fakes standing in for the two known NodeSDK layouts and the failure cases. detectShape inspects the
// class SOURCE (Function.prototype.toString), so each fake must DECLARE the field the corresponding
// sdk-node era declares — the FIELD era declares `_tracerProviderConfig`, the CONFIG era removed it.
// The register patch relies on detectShape to choose an injection strategy and to disable safely on
// anything else.
class FieldShapeSdk {
  // FIELD era (<= 0.219) declares this private field.
  _tracerProviderConfig: unknown;
  _configuration: unknown;
  constructor(config: { spanProcessors: unknown[] }) {
    this._tracerProviderConfig = { spanProcessors: config.spanProcessors };
    this._configuration = config;
  }
}
class ConfigShapeSdk {
  // CONFIG era (>= 0.220) declares only _configuration; no _tracerProviderConfig.
  _configuration: unknown;
  constructor(config: unknown) {
    this._configuration = config;
  }
}
class UnknownShapeSdk {
  _somethingElse: number = 1;
}

describe('detectShape', () => {
  it('detects the FIELD shape (<= sdk-node 0.219: declares _tracerProviderConfig)', () => {
    assert.strictEqual(detectShape(FieldShapeSdk as any, 'test'), 'FIELD');
  });

  it('detects the CONFIG shape (>= sdk-node 0.220: only _configuration)', () => {
    assert.strictEqual(detectShape(ConfigShapeSdk as any, 'test'), 'CONFIG');
  });

  // N9: the FIELD era declares BOTH fields (_tracerProviderConfig and _configuration). This asserts
  // the branch ORDER — _tracerProviderConfig must be checked first — so that reversing the branches
  // (which would misclassify every FIELD-era version as CONFIG) fails the suite.
  it('resolves to FIELD when both fields are present (era declares both)', () => {
    assert.strictEqual(detectShape(FieldShapeSdk as any, 'test'), 'FIELD');
    // Guard the invariant explicitly: the fake really does mention both names.
    const src = FieldShapeSdk.toString();
    assert.ok(src.includes('_tracerProviderConfig') && src.includes('_configuration'), 'fake must declare both');
  });

  it('returns UNKNOWN when neither known field is present (disables the patch)', () => {
    assert.strictEqual(detectShape(UnknownShapeSdk as any, 'test'), 'UNKNOWN');
  });

  it('returns UNKNOWN when toString throws', () => {
    const hostile = {
      toString: () => {
        throw new Error('boom');
      },
    } as any;
    assert.strictEqual(detectShape(hostile, 'test'), 'UNKNOWN');
  });

  // B4: detection must be side-effect-free. A NodeSDK stand-in whose construction has an observable
  // side effect must NOT be constructed by detectShape.
  it('does not instantiate the class (no construction side effects)', () => {
    let constructed = false;
    class SideEffectSdk {
      _configuration: unknown;
      constructor() {
        constructed = true; // e.g. binding a Prometheus exporter on :9464
        this._configuration = {};
      }
    }
    const shape = detectShape(SideEffectSdk as any, 'test');
    assert.strictEqual(shape, 'CONFIG');
    assert.strictEqual(constructed, false, 'detectShape must not construct the SDK');
  });
});
