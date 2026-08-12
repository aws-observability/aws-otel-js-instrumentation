// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import { detectShape } from '../src/internal/detect-shape';

// Fakes standing in for the two known NodeSDK layouts and the failure cases. The register patch
// relies on detectShape to choose an injection strategy and to disable safely on anything else.
class FieldShapeSdk {
  _tracerProviderConfig: unknown;
  constructor(config: { spanProcessors: unknown[] }) {
    this._tracerProviderConfig = { spanProcessors: config.spanProcessors };
  }
}
class ConfigShapeSdk {
  _configuration: unknown;
  constructor(config: unknown) {
    this._configuration = config;
  }
}
class UnknownShapeSdk {
  _somethingElse: number = 1;
}
class ThrowingSdk {
  constructor() {
    throw new Error('constructor boom');
  }
}

describe('detectShape', () => {
  it('detects the FIELD shape (<= sdk-node 0.219: _tracerProviderConfig)', () => {
    assert.strictEqual(detectShape(FieldShapeSdk as any, 'test'), 'FIELD');
  });

  it('detects the CONFIG shape (>= sdk-node 0.220: _configuration)', () => {
    assert.strictEqual(detectShape(ConfigShapeSdk as any, 'test'), 'CONFIG');
  });

  it('returns UNKNOWN when neither known field is present (disables the patch)', () => {
    assert.strictEqual(detectShape(UnknownShapeSdk as any, 'test'), 'UNKNOWN');
  });

  it('returns UNKNOWN when constructing the probe throws', () => {
    assert.strictEqual(detectShape(ThrowingSdk as any, 'test'), 'UNKNOWN');
  });
});
