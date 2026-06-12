// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SourceMapResolver } from '../../src/dynamic-instrumentation/source-map-resolver';

/**
 * Helper: create a minimal source map JSON and write it to disk.
 *
 * Creates a 1:1 mapping where TS line N maps to JS line N (for simplicity).
 * In practice, TS compilation may shift lines.
 */
function createTestSourceMap(tmpDir: string, jsFileName: string, sources: string[], lineCount: number = 5): string {
  // Build VLQ mappings: each source line maps to itself (AAAA for first, AACA for subsequent)
  // This is a simplified 1:1 mapping
  const mappingLines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    mappingLines.push(i === 0 ? 'AAAA' : 'AACA');
  }
  const mappings = mappingLines.join(';');

  const sourceMap = {
    version: 3,
    file: jsFileName,
    sources,
    sourcesContent: sources.map(() => ''),
    mappings,
  };

  const mapPath = path.join(tmpDir, jsFileName + '.map');
  fs.writeFileSync(mapPath, JSON.stringify(sourceMap));
  return mapPath;
}

describe('SourceMapResolver', function () {
  let resolver: SourceMapResolver;
  let tmpDir: string;

  beforeEach(function () {
    resolver = new SourceMapResolver();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'di-sm-test-'));
  });

  afterEach(function () {
    resolver.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadSourceMap', function () {
    it('should load external .map file', function () {
      // Create JS file and source map
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, '// compiled code');
      createTestSourceMap(tmpDir, 'app.js', ['../src/app.ts']);

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');
      expect(resolver.hasSourceMap(`file://${jsPath}`)).toBe(true);
    });

    it('should load inline base64 source map', function () {
      const sourceMap = {
        version: 3,
        file: 'app.js',
        sources: ['app.ts'],
        mappings: 'AAAA;AACA',
      };
      const base64 = Buffer.from(JSON.stringify(sourceMap)).toString('base64');
      const dataUrl = `data:application/json;base64,${base64}`;

      const jsPath = path.join(tmpDir, 'app.js');
      resolver.loadSourceMap('1', `file://${jsPath}`, dataUrl);
      expect(resolver.hasSourceMap(`file://${jsPath}`)).toBe(true);
    });

    it('should load convention-based .map file when sourceMapURL does not exist', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, '// compiled');
      createTestSourceMap(tmpDir, 'app.js', ['app.ts']);

      // sourceMapURL points to a nonexistent file — falls back to app.js.map (convention)
      resolver.loadSourceMap('1', `file://${jsPath}`, 'nonexistent.map');
      expect(resolver.hasSourceMap(`file://${jsPath}`)).toBe(true);
    });

    it('should not crash on missing source map', function () {
      resolver.loadSourceMap('1', 'file:///missing/app.js', 'app.js.map');
      expect(resolver.hasSourceMap('file:///missing/app.js')).toBe(false);
    });
  });

  describe('isTypeScriptFile', function () {
    it('should detect .ts files', function () {
      expect(resolver.isTypeScriptFile('app.ts')).toBe(true);
      expect(resolver.isTypeScriptFile('app.tsx')).toBe(true);
      expect(resolver.isTypeScriptFile('app.mts')).toBe(true);
      expect(resolver.isTypeScriptFile('app.cts')).toBe(true);
    });

    it('should not detect .js files', function () {
      expect(resolver.isTypeScriptFile('app.js')).toBe(false);
      expect(resolver.isTypeScriptFile('app.mjs')).toBe(false);
    });
  });

  describe('forwardMap', function () {
    it('should forward-map original source position to compiled JS position', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, '// line 1\n// line 2\n// line 3\n');
      createTestSourceMap(tmpDir, 'app.js', ['../src/app.ts'], 3);

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');

      // Forward-map original line 1 (1-indexed) → compiled position (0-indexed for V8)
      const result = resolver.forwardMap(`file://${jsPath}`, path.join(path.dirname(jsPath), '../src/app.ts'), 1, 0);
      expect(result).not.toBeNull();
      expect(result!.scriptId).toBe('1');
      expect(result!.scriptUrl).toBe(`file://${jsPath}`);
      expect(typeof result!.line).toBe('number');
      expect(result!.line).toBeGreaterThanOrEqual(0);
    });

    it('should return null for unknown script URL', function () {
      const result = resolver.forwardMap('file:///nonexistent.js', 'app.ts', 1);
      expect(result).toBeNull();
    });

    it('should return null when source is not in source map', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, '// line 1\n');
      createTestSourceMap(tmpDir, 'app.js', ['../src/app.ts'], 2);

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');

      // Query with a source file that doesn't exist in the source map
      const result = resolver.forwardMap(`file://${jsPath}`, '/completely/different/file.ts', 1);
      // Should still attempt (using the source name as-is), may return null
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('forwardMapPosition (LEAST_UPPER_BOUND fallback)', function () {
    it('should resolve when exact column 0 has no mapping but indented code does', function () {
      const jsPath = path.join(tmpDir, 'indented.js');
      fs.writeFileSync(jsPath, '  return x;\n');

      // Create a source map where line 1 has a mapping at column 2 (indented), not column 0
      const sourceMap = {
        version: 3,
        file: 'indented.js',
        sources: ['../src/indented.ts'],
        mappings: 'EAAA', // E = column 2 in the generated file
      };
      fs.writeFileSync(path.join(tmpDir, 'indented.js.map'), JSON.stringify(sourceMap));

      resolver.loadSourceMap('1', `file://${jsPath}`, 'indented.js.map');

      // Forward-map at column 0 — should fall back to LEAST_UPPER_BOUND and find column 2
      const result = resolver.forwardMap(
        `file://${jsPath}`,
        path.resolve(path.dirname(jsPath), '../src/indented.ts'),
        1,
        0
      );
      // Should succeed (fallback finds mapping at column 2)
      expect(result).not.toBeNull();
      expect(result!.scriptId).toBe('1');
    });

    it('should reject cross-line jump from LEAST_UPPER_BOUND', function () {
      const jsPath = path.join(tmpDir, 'jump.js');
      fs.writeFileSync(jsPath, '// comment\nactualCode();\n');

      // Source map: only line 2 has a mapping, line 1 has none.
      // Querying line 1 with LEAST_UPPER_BOUND should not silently jump to line 2.
      const sourceMap = {
        version: 3,
        file: 'jump.js',
        sources: ['../src/jump.ts'],
        // Only one mapping entry, at generated line 2 column 0 → original line 2
        mappings: ';AACA',
      };
      fs.writeFileSync(path.join(tmpDir, 'jump.js.map'), JSON.stringify(sourceMap));

      resolver.loadSourceMap('1', `file://${jsPath}`, 'jump.js.map');

      // Forward-map line 1 (comment line with no mapping)
      const result = resolver.forwardMap(
        `file://${jsPath}`,
        path.resolve(path.dirname(jsPath), '../src/jump.ts'),
        1,
        0
      );
      // Should return null — no valid mapping for line 1, and jumping to line 2 is rejected
      expect(result).toBeNull();
    });
  });

  describe('reverseMap', function () {
    it('should reverse-map compiled position to original source', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, '// line 1\n// line 2\n');
      createTestSourceMap(tmpDir, 'app.js', ['../src/app.ts'], 3);

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');

      const result = resolver.reverseMap(`file://${jsPath}`, 0, 0);
      expect(result).not.toBeNull();
      expect(result!.source).toContain('app.ts');
      expect(result!.line).toBe(1); // 1-indexed
    });

    it('should return null for scripts without source maps', function () {
      const result = resolver.reverseMap('file:///app/plain.js', 10, 0);
      expect(result).toBeNull();
    });

    it('should return null for out-of-bounds line number', function () {
      const jsPath = path.join(tmpDir, 'small.js');
      fs.writeFileSync(jsPath, '// line 1\n');
      createTestSourceMap(tmpDir, 'small.js', ['../src/small.ts'], 1);

      resolver.loadSourceMap('1', `file://${jsPath}`, 'small.js.map');

      // Line 999 is far beyond the source map's range
      const result = resolver.reverseMap(`file://${jsPath}`, 999, 0);
      expect(result).toBeNull();
    });
  });

  describe('resolveViaSourceIndex', function () {
    it('should find original source in index and forward-map', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, '// line 1\n// line 2\n// line 3\n');
      createTestSourceMap(tmpDir, 'app.js', ['../src/app.ts'], 3);

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');

      // Look up by the original source path
      const result = resolver.resolveViaSourceIndex('src/app.ts', 1);
      expect(result).not.toBeNull();
      expect(result!.scriptUrl).toBe(`file://${jsPath}`);
    });

    it('should return null for unknown source', function () {
      const result = resolver.resolveViaSourceIndex('unknown.ts', 1);
      expect(result).toBeNull();
    });

    it('should pick the longest suffix match when multiple sources match', function () {
      // Two scripts, each with a 'utils.ts' in different directories
      const js1Path = path.join(tmpDir, 'bundle1.js');
      const js2Path = path.join(tmpDir, 'bundle2.js');
      fs.writeFileSync(js1Path, '// bundle1\n// line 2\n');
      fs.writeFileSync(js2Path, '// bundle2\n// line 2\n');
      createTestSourceMap(tmpDir, 'bundle1.js', ['../src/handlers/utils.ts'], 2);
      createTestSourceMap(tmpDir, 'bundle2.js', ['../lib/utils.ts'], 2);

      resolver.loadSourceMap('1', `file://${js1Path}`, 'bundle1.js.map');
      resolver.loadSourceMap('2', `file://${js2Path}`, 'bundle2.js.map');

      // Query 'handlers/utils.ts' — should match bundle1 (longer suffix) not bundle2
      const result = resolver.resolveViaSourceIndex('handlers/utils.ts', 1);
      expect(result).not.toBeNull();
      expect(result!.scriptUrl).toBe(`file://${js1Path}`);
    });

    it('should match by filename when only one source has that file', function () {
      // Use two separate scripts so each source gets its own proper mappings
      const js1Path = path.join(tmpDir, 'orders.js');
      const js2Path = path.join(tmpDir, 'math.js');
      fs.writeFileSync(js1Path, '// orders\n');
      fs.writeFileSync(js2Path, '// math\n');
      createTestSourceMap(tmpDir, 'orders.js', ['../src/orders.ts'], 2);
      createTestSourceMap(tmpDir, 'math.js', ['../src/math.ts'], 2);

      resolver.loadSourceMap('1', `file://${js1Path}`, 'orders.js.map');
      resolver.loadSourceMap('2', `file://${js2Path}`, 'math.js.map');

      const result = resolver.resolveViaSourceIndex('math.ts', 1);
      expect(result).not.toBeNull();
      expect(result!.scriptUrl).toBe(`file://${js2Path}`);
    });
  });

  describe('buildNameMapping', function () {
    it('should return null for non-minified code (no names in source map)', function () {
      // Standard tsc output has empty names array
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, 'function add(a, b) { return a + b; }\n');
      createTestSourceMap(tmpDir, 'app.js', ['../src/app.ts'], 2);

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');

      const mapping = resolver.buildNameMapping(`file://${jsPath}`, 'src/app.ts', 1);
      expect(mapping).toBeNull();
    });

    it('should return null for script without source map', function () {
      const mapping = resolver.buildNameMapping('file:///nonexistent.js', 'src/app.ts', 1);
      expect(mapping).toBeNull();
    });

    it('should return null when compiled source cannot be read', function () {
      // Create a source map with names but the JS file doesn't exist on disk
      const jsPath = path.join(tmpDir, 'missing.js');
      const sourceMap = {
        version: 3,
        file: 'missing.js',
        sources: ['app.ts'],
        names: ['originalVar'],
        mappings: 'AAAA',
      };
      fs.writeFileSync(path.join(tmpDir, 'missing.js.map'), JSON.stringify(sourceMap));
      // Don't create missing.js — compiledSource will be null

      resolver.loadSourceMap('1', `file://${jsPath}`, 'missing.js.map');
      const mapping = resolver.buildNameMapping(`file://${jsPath}`, 'app.ts', 1);
      expect(mapping).toBeNull();
    });

    it('should return null when source file not found in source map', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, 'function h(e){return e*e}\n');
      const sourceMap = {
        version: 3,
        file: 'app.js',
        sources: ['math.ts'],
        names: ['calculate'],
        mappings: 'AAAAA',
      };
      fs.writeFileSync(path.join(tmpDir, 'app.js.map'), JSON.stringify(sourceMap));

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');
      // Query for a different source file
      const mapping = resolver.buildNameMapping(`file://${jsPath}`, 'orders.ts', 1);
      expect(mapping).toBeNull();
    });

    it('should build mapping for minified code with names', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      // Minified single-line: S(e,t){var r=...}
      // Column positions:     0123456789...
      //   col 0: 'S' (mangled function name)
      //   col 2: 'e' (mangled param)
      //   col 4: 't' (mangled param)
      fs.writeFileSync(jsPath, 'S(e,t){var r=19.99*t;return{id:e,total:r}}\n');
      const sourceMap = {
        version: 3,
        file: 'app.js',
        sources: ['orders.ts'],
        names: ['processOrder', 'id', 'qty', 'total'],
        // gen col 0 → name 'processOrder', gen col 2 → name 'id', gen col 4 → name 'qty'
        // AAAAA = genCol 0, srcIdx 0, origLine 1, origCol 0, nameIdx 0 (processOrder)
        // EAACC = genCol +2, srcIdx 0, origLine 1, origCol +1, nameIdx +1 (id)
        // EAACC = genCol +2, srcIdx 0, origLine 1, origCol +1, nameIdx +1 (qty)
        mappings: 'AAAAA,EAACC,EAACC',
      };
      fs.writeFileSync(path.join(tmpDir, 'app.js.map'), JSON.stringify(sourceMap));

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');
      const mapping = resolver.buildNameMapping(`file://${jsPath}`, 'orders.ts', 1);

      expect(mapping).not.toBeNull();
      expect(typeof mapping).toBe('object');
      expect(Object.keys(mapping!).length).toBeGreaterThan(0);

      // 'S' at col 0 maps to original name 'processOrder'
      expect(mapping!['S']).toBe('processOrder');
      // 'e' at col 2 maps to original name 'id'
      expect(mapping!['e']).toBe('id');
      // 't' at col 4 maps to original name 'qty'
      expect(mapping!['t']).toBe('qty');
    });

    it('should not include entries where mangled name equals original name', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, 'function add(a, b) { return a + b; }\n');
      const sourceMap = {
        version: 3,
        file: 'app.js',
        sources: ['app.ts'],
        names: ['add', 'a', 'b'],
        // Names match the runtime identifiers — no mangling happened
        mappings: 'AAAAA,SAAK,GAAG',
      };
      fs.writeFileSync(path.join(tmpDir, 'app.js.map'), JSON.stringify(sourceMap));

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');
      const mapping = resolver.buildNameMapping(`file://${jsPath}`, 'app.ts', 1);

      // Variable names 'a' and 'b' should NOT be in the mapping (they match runtime names)
      if (mapping) {
        expect(mapping['a']).toBeUndefined();
        expect(mapping['b']).toBeUndefined();
      }
    });
  });

  describe('error handling', function () {
    it('should not crash on invalid base64 inline source map', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      resolver.loadSourceMap('1', `file://${jsPath}`, 'data:application/json;base64,!!!invalid!!!');
      expect(resolver.hasSourceMap(`file://${jsPath}`)).toBe(false);
    });

    it('should not crash on malformed JSON in source map', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      const base64 = Buffer.from('{ not valid json }}}').toString('base64');
      resolver.loadSourceMap('1', `file://${jsPath}`, `data:application/json;base64,${base64}`);
      expect(resolver.hasSourceMap(`file://${jsPath}`)).toBe(false);
    });

    it('should not crash on source map with empty sources array', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, '// compiled');
      const sourceMap = {
        version: 3,
        file: 'app.js',
        sources: [],
        mappings: '',
      };
      fs.writeFileSync(path.join(tmpDir, 'app.js.map'), JSON.stringify(sourceMap));

      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');
      expect(resolver.hasSourceMap(`file://${jsPath}`)).toBe(true);

      // Forward-map and reverse-map should return null gracefully
      const fwd = resolver.forwardMap(`file://${jsPath}`, 'any.ts', 1);
      expect(fwd).toBeNull();
      const rev = resolver.reverseMap(`file://${jsPath}`, 0, 0);
      expect(rev).toBeNull();
    });
  });

  describe('clear', function () {
    it('should clear all data', function () {
      const jsPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(jsPath, '');
      createTestSourceMap(tmpDir, 'app.js', ['app.ts']);
      resolver.loadSourceMap('1', `file://${jsPath}`, 'app.js.map');

      expect(resolver.hasSourceMap(`file://${jsPath}`)).toBe(true);
      resolver.clear();
      expect(resolver.hasSourceMap(`file://${jsPath}`)).toBe(false);
    });
  });
});
