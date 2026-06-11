// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the scope rule in `shouldTransformFile`.
 *
 * There is no implicit default scope: PACKAGES_INCLUDE is the only opt-in and
 * PACKAGES_EXCLUDE the only way to subtract. Decision (highest priority first):
 *   0. Matches SDK_SELF_EXCLUDE (non-configurable) → drop
 *   1. PACKAGES_INCLUDE empty → drop
 *   2. Matches PACKAGES_EXCLUDE → drop
 *   3. Matches PACKAGES_INCLUDE → instrument
 *   4. Otherwise → drop
 *
 * Call signature is `shouldTransformFile(filePath, packagesExclude, packagesInclude)`
 * — exclude is the 2nd arg, include the 3rd (preserved from the original to avoid
 * call-site churn). These rules are only reachable when FUNCTION_INSTRUMENT_ENABLED=true
 * (the hook isn't installed otherwise).
 */

import expect from 'expect';
import { shouldTransformFile, SDK_SELF_EXCLUDE } from '../../src/serviceevents/ast-transformation';

describe('shouldTransformFile (scope precedence)', function () {
  // --- Baseline rules 0–4 ---

  describe('rule 1: empty include drops all', function () {
    it('drops any user module when PACKAGES_INCLUDE is empty (no implicit default scope)', function () {
      expect(shouldTransformFile('/app/src/handlers/user.ts', [], [])).toBe(false);
    });

    it('drops even node_modules-free app source when include is empty', function () {
      expect(shouldTransformFile('/app/index.js', [], [])).toBe(false);
    });
  });

  describe('rule 3: include match instruments', function () {
    it('instruments a file matching PACKAGES_INCLUDE', function () {
      expect(shouldTransformFile('/app/src/myapp/foo.js', [], ['**/myapp/**'])).toBe(true);
    });
  });

  describe('rule 4: include no match drops', function () {
    it('drops a file outside the include when PACKAGES_INCLUDE is non-empty', function () {
      expect(shouldTransformFile('/app/src/other/bar.ts', [], ['**/myapp/**'])).toBe(false);
    });
  });

  describe('rule 2: exclude beats include', function () {
    it('drops a file that matches both include and exclude', function () {
      expect(shouldTransformFile('/app/src/myapp/internal/secret.ts', ['**/internal/**'], ['**/myapp/**'])).toBe(false);
    });
  });

  describe('rule 0: SDK_SELF_EXCLUDE (non-configurable)', function () {
    it('drops @opentelemetry even under a wildcard include', function () {
      // ['**/*'] survives the validator (bare '*'/'**' are stripped in config.ts).
      expect(shouldTransformFile('/app/node_modules/@opentelemetry/api/index.js', [], ['**/*'])).toBe(false);
    });

    it('drops the ADOT distro even under a wildcard include', function () {
      const r = shouldTransformFile(
        '/app/node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation/build/src/serviceevents/monitor.js',
        [],
        ['**/*']
      );
      expect(r).toBe(false);
    });

    it('drops the transform toolchain (acorn/pirates/minimatch) under a wildcard include', function () {
      expect(shouldTransformFile('/app/node_modules/acorn/dist/acorn.js', [], ['**/*'])).toBe(false);
      expect(shouldTransformFile('/app/node_modules/pirates/lib/index.js', [], ['**/*'])).toBe(false);
      expect(shouldTransformFile('/app/node_modules/minimatch/minimatch.js', [], ['**/*'])).toBe(false);
    });

    it('does NOT exclude user code merely named like the toolchain (anchored to /node_modules/<pkg>/)', function () {
      // Regression: the toolchain entries are anchored to /node_modules/acorn/ etc., not a bare
      // /acorn/, so a user source dir or a customer-published package sharing the name is still
      // instrumentable (acorn/pirates/minimatch are ordinary words).
      expect(shouldTransformFile('/app/src/pirates/index.js', [], ['**/*'])).toBe(true);
      expect(shouldTransformFile('/app/node_modules/@mycompany/pirates/index.js', [], ['**/@mycompany/**'])).toBe(true);
      expect(shouldTransformFile('/app/node_modules/acorn-helpers/index.js', [], ['**/*'])).toBe(true);
    });

    it('cannot be opted back in even when the include explicitly names @opentelemetry', function () {
      expect(shouldTransformFile('/app/node_modules/@opentelemetry/api/index.js', [], ['**/@opentelemetry/**'])).toBe(
        false
      );
    });

    it('does NOT exclude a user project directory merely named serviceevents', function () {
      // SDK_SELF_EXCLUDE anchors on the distro package path, not a bare /serviceevents/ segment.
      expect(shouldTransformFile('/app/src/serviceevents/my-code.ts', [], ['**/*'])).toBe(true);
    });
  });

  // --- The capability the ignoreNodeModules:false flip enables ---

  describe('third-party node_modules instrumentation (Python parity)', function () {
    it('instruments a customer-published internal package under node_modules when included', function () {
      expect(shouldTransformFile('/app/node_modules/@mycompany/lib/index.js', [], ['**/@mycompany/**'])).toBe(true);
    });

    it('still drops an un-included node_modules package (rule 4, not a blanket node_modules block)', function () {
      expect(shouldTransformFile('/app/node_modules/lodash/index.js', [], ['**/@mycompany/**'])).toBe(false);
    });
  });

  // --- INCLUDE coverage gaps ---

  describe('include coverage gaps', function () {
    it('unions multiple include patterns', function () {
      expect(shouldTransformFile('/app/otherapp/foo.js', [], ['**/myapp/**', '**/otherapp/**'])).toBe(true);
    });

    it('a non-empty unrelated exclude must not poison the include', function () {
      expect(shouldTransformFile('/app/myapp/foo.js', ['**/otherapp/**'], ['**/myapp/**'])).toBe(true);
    });

    it('glob depth pinning: myapp/* matches one level but not deeper', function () {
      // minimatch matchBase: a single * does not cross '/'.
      expect(shouldTransformFile('/app/myapp/foo.js', [], ['**/myapp/*'])).toBe(true);
      expect(shouldTransformFile('/app/myapp/sub/bar.js', [], ['**/myapp/*'])).toBe(false);
      // ** crosses '/', so the deeper file is matched with the double-star form.
      expect(shouldTransformFile('/app/myapp/sub/bar.js', [], ['**/myapp/**'])).toBe(true);
    });
  });

  // --- EXCLUDE coverage gaps ---

  describe('exclude coverage gaps', function () {
    it('rule 1 fires before rule 2 — exclude alone never opens the gate', function () {
      expect(shouldTransformFile('/app/other/bar.js', ['**/myapp/**'], [])).toBe(false);
    });

    it('unions multiple exclude patterns', function () {
      expect(shouldTransformFile('/app/myapp/legacy/bar.js', ['**/internal/**', '**/legacy/**'], ['**/myapp/**'])).toBe(
        false
      );
    });

    it('an unmatched multi-pattern exclude still includes', function () {
      expect(shouldTransformFile('/app/myapp/public/baz.js', ['**/internal/**', '**/legacy/**'], ['**/myapp/**'])).toBe(
        true
      );
    });

    it('a non-matching exclude falls through to the include', function () {
      expect(shouldTransformFile('/app/myapp/foo.js', ['**/otherapp/**'], ['**/myapp/**'])).toBe(true);
    });

    it('exclude wins when it collides exactly with the include', function () {
      expect(shouldTransformFile('/app/myapp/foo.js', ['**/myapp/**'], ['**/myapp/**'])).toBe(false);
    });

    it('SDK_SELF_EXCLUDE wins over a redundant user exclude that names the SDK', function () {
      expect(
        shouldTransformFile('/app/node_modules/@opentelemetry/api/index.js', ['**/@opentelemetry/**'], ['**/*'])
      ).toBe(false);
    });

    it('glob depth pinning: myapp/secret/* misses a deeper secret without **', function () {
      // Foot-gun: a single-* exclude won't catch nested secrets.
      expect(shouldTransformFile('/app/myapp/secret/sub/leak.js', ['**/myapp/secret/*'], ['**/myapp/**'])).toBe(true);
      expect(shouldTransformFile('/app/myapp/secret/leak.js', ['**/myapp/secret/*'], ['**/myapp/**'])).toBe(false);
    });
  });

  // --- The SDK_SELF_EXCLUDE constant itself (regression guard) ---

  describe('SDK_SELF_EXCLUDE constant', function () {
    it('does NOT blanket-exclude node_modules (so 3rd-party instrumentation is possible)', function () {
      // No entry is a bare `node_modules` / `/node_modules/` segment that would match every
      // installed package. The toolchain entries are the specific `/node_modules/<pkg>/` form.
      expect(SDK_SELF_EXCLUDE).not.toContain('node_modules');
      expect(SDK_SELF_EXCLUDE).not.toContain('/node_modules/');
      expect(SDK_SELF_EXCLUDE.some(s => s === 'node_modules' || s === '/node_modules/')).toBe(false);
    });

    it('covers OTel, the ADOT distro, and the transform toolchain', function () {
      expect(SDK_SELF_EXCLUDE).toContain('/@opentelemetry/');
      expect(SDK_SELF_EXCLUDE).toContain('/@aws/aws-distro-opentelemetry-node-autoinstrumentation/');
      // Toolchain entries are anchored to /node_modules/<pkg>/ so they can't false-positive on
      // user dirs/packages sharing these common-word names.
      expect(SDK_SELF_EXCLUDE).toContain('/node_modules/acorn/');
      expect(SDK_SELF_EXCLUDE).toContain('/node_modules/pirates/');
      expect(SDK_SELF_EXCLUDE).toContain('/node_modules/minimatch/');
    });
  });
});
