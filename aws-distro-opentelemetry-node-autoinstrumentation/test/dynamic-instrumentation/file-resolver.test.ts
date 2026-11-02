// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { FileResolver, boundaryAwareSuffixMatch } from '../../src/dynamic-instrumentation/file-resolver';
import { SourceMapResolver } from '../../src/dynamic-instrumentation/source-map-resolver';

describe('boundaryAwareSuffixMatch', function () {
  it('should match exact path', function () {
    expect(boundaryAwareSuffixMatch('app.js', 'app.js')).toBeGreaterThan(0);
  });

  it('should match suffix at path boundary', function () {
    expect(boundaryAwareSuffixMatch('app.js', '/src/app.js')).toBeGreaterThan(0);
  });

  it('should match deeper suffix', function () {
    expect(boundaryAwareSuffixMatch('src/app.js', '/home/user/src/app.js')).toBeGreaterThan(0);
  });

  it('should reject non-boundary match', function () {
    expect(boundaryAwareSuffixMatch('pp.js', '/src/app.js')).toBe(0);
  });

  it('should reject partial filename match', function () {
    expect(boundaryAwareSuffixMatch('ice.js', '/src/service.js')).toBe(0);
  });

  it('should be case insensitive', function () {
    expect(boundaryAwareSuffixMatch('App.JS', '/src/app.js')).toBeGreaterThan(0);
  });

  it('should match when both use forward slashes', function () {
    // Note: backslash normalization happens in FileResolver.resolve(), not in the raw match function
    expect(boundaryAwareSuffixMatch('src/app.js', '/home/user/src/app.js')).toBeGreaterThan(0);
  });

  it('should return 0 for empty query', function () {
    expect(boundaryAwareSuffixMatch('', '/src/app.js')).toBe(0);
  });

  it('should return 0 for no match', function () {
    expect(boundaryAwareSuffixMatch('other.js', '/src/app.js')).toBe(0);
  });
});

describe('FileResolver', function () {
  let resolver: FileResolver;

  beforeEach(function () {
    resolver = new FileResolver();
  });

  it('should resolve by exact filename', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/src/service.js' });
    const result = resolver.resolve('service.js');
    expect(result).not.toBeNull();
    expect(result!.scriptId).toBe('1');
  });

  it('should resolve by partial path', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/src/handlers/order.js' });
    const result = resolver.resolve('handlers/order.js');
    expect(result).not.toBeNull();
    expect(result!.scriptId).toBe('1');
  });

  it('should resolve by full path', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/src/main.js' });
    const result = resolver.resolve('/app/src/main.js');
    expect(result).not.toBeNull();
  });

  it('should resolve file:// URLs', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/src/main.js' });
    const result = resolver.resolve('file:///app/src/main.js');
    expect(result).not.toBeNull();
  });

  it('should return null for no match', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/src/main.js' });
    const result = resolver.resolve('nonexistent.js');
    expect(result).toBeNull();
  });

  it('should exclude node_modules by default', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/node_modules/lib/index.js' });
    const result = resolver.resolve('index.js');
    expect(result).toBeNull();
  });

  it('should return null for ambiguous matches', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/a/service.js' });
    resolver.addScript({ scriptId: '2', url: 'file:///app/b/service.js' });
    const result = resolver.resolve('service.js');
    // Both match with same length — ambiguous
    expect(result).toBeNull();
  });

  it('should disambiguate by unique path prefix', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/src/service.js' });
    resolver.addScript({ scriptId: '2', url: 'file:///other/lib/service.js' });
    // 'app/src/service.js' uniquely matches script 1
    const result = resolver.resolve('app/src/service.js');
    expect(result).not.toBeNull();
    expect(result!.scriptId).toBe('1');
  });

  it('should handle backslash paths via normalization', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/src/service.js' });
    const result = resolver.resolve('src\\service.js');
    expect(result).not.toBeNull();
    expect(result!.scriptId).toBe('1');
  });

  it('should skip eval scripts', function () {
    resolver.addScript({ scriptId: '1', url: 'evalmachine.<anonymous>' });
    const result = resolver.resolve('evalmachine.<anonymous>');
    expect(result).toBeNull();
  });

  it('should track script URL by ID', function () {
    resolver.addScript({ scriptId: '42', url: 'file:///app/test.js' });
    expect(resolver.getScriptUrl('42')).toBe('file:///app/test.js');
    expect(resolver.getScriptUrl('999')).toBe('');
  });

  it('should clear all scripts', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/a.js' });
    resolver.addScript({ scriptId: '2', url: 'file:///app/b.js' });
    expect(resolver.getScriptCount()).toBe(2);
    resolver.clear();
    expect(resolver.getScriptCount()).toBe(0);
  });
});

/**
 * Creates a mock SourceMapResolver with configurable behavior.
 * Only stubs the methods that FileResolver calls.
 */
function createMockSourceMapResolver(overrides: {
  hasSourceMap?: (url: string) => boolean;
  forwardMap?: (url: string, source: string, line: number, col: number) => any;
  resolveViaSourceIndex?: (filePath: string, line: number, col: number) => any;
}): SourceMapResolver {
  const mock = {
    hasSourceMap: overrides.hasSourceMap ?? (() => false),
    forwardMap: overrides.forwardMap ?? (() => null),
    resolveViaSourceIndex: overrides.resolveViaSourceIndex ?? (() => null),
  };
  return mock as unknown as SourceMapResolver;
}

describe('FileResolver — source map integration', function () {
  let resolver: FileResolver;

  beforeEach(function () {
    resolver = new FileResolver();
  });

  it('should forward-map through source map when direct match has source map', function () {
    // Compiled JS is loaded as a V8 script; user targets the original TS file
    resolver.addScript({ scriptId: '1', url: 'file:///app/dist/app.js' });

    const smResolver = createMockSourceMapResolver({
      hasSourceMap: url => url === 'file:///app/dist/app.js',
      forwardMap: (_url, _source, line, _col) => ({
        scriptId: '1',
        scriptUrl: 'file:///app/dist/app.js',
        line: line + 5, // TS line 10 → JS line 15 (0-indexed)
        column: 0,
      }),
    });
    resolver.setSourceMapResolver(smResolver);

    // 'dist/app.js' suffix-matches the V8 script, but the user's config says 'src/app.ts'
    // In this case the direct match is for the compiled JS file
    const result = resolver.resolve('dist/app.js', 10);
    expect(result).not.toBeNull();
    expect(result!.sourceMapResolved).toBe(true);
    expect(result!.resolvedLine).toBe(15);
    expect(result!.resolvedColumn).toBe(0);
  });

  it('should fall back to direct match when forward-map fails', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/dist/app.js' });

    const smResolver = createMockSourceMapResolver({
      hasSourceMap: url => url === 'file:///app/dist/app.js',
      forwardMap: () => null, // Forward-map fails (e.g., comment line with no mapping)
    });
    resolver.setSourceMapResolver(smResolver);

    const result = resolver.resolve('dist/app.js', 10);
    expect(result).not.toBeNull();
    expect(result!.scriptId).toBe('1');
    expect(result!.sourceMapResolved).toBeUndefined();
    expect(result!.resolvedLine).toBeUndefined();
  });

  it('should skip source map forward-map when lineNumber is not provided', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/dist/app.js' });

    let forwardMapCalled = false;
    const smResolver = createMockSourceMapResolver({
      hasSourceMap: () => true,
      forwardMap: () => {
        forwardMapCalled = true;
        return null;
      },
    });
    resolver.setSourceMapResolver(smResolver);

    // No lineNumber — should use direct match without attempting forward-map
    const result = resolver.resolve('dist/app.js');
    expect(result).not.toBeNull();
    expect(result!.scriptId).toBe('1');
    expect(forwardMapCalled).toBe(false);
  });

  it('should resolve via source map index when no direct match (Phase 2)', function () {
    // The compiled JS is 'bundle.js' — user targets 'src/orders.ts' which doesn't match any V8 URL
    resolver.addScript({ scriptId: '1', url: 'file:///app/dist/bundle.js' });

    const smResolver = createMockSourceMapResolver({
      resolveViaSourceIndex: (filePath, line, _col) => {
        if (filePath === 'src/orders.ts') {
          return {
            scriptId: '1',
            scriptUrl: 'file:///app/dist/bundle.js',
            line: line + 20, // TS line 5 → bundle line 25
            column: 4,
          };
        }
        return null;
      },
    });
    resolver.setSourceMapResolver(smResolver);

    const result = resolver.resolve('src/orders.ts', 5);
    expect(result).not.toBeNull();
    expect(result!.scriptId).toBe('1');
    expect(result!.url).toBe('file:///app/dist/bundle.js');
    expect(result!.sourceMapResolved).toBe(true);
    expect(result!.resolvedLine).toBe(25);
    expect(result!.resolvedColumn).toBe(4);
  });

  it('should return null when both direct match and source index miss', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/dist/bundle.js' });

    const smResolver = createMockSourceMapResolver({
      resolveViaSourceIndex: () => null,
    });
    resolver.setSourceMapResolver(smResolver);

    const result = resolver.resolve('src/unknown.ts', 10);
    expect(result).toBeNull();
  });

  it('should return null for TS file without source map resolver', function () {
    // No source map resolver set — TS file can't be resolved
    resolver.addScript({ scriptId: '1', url: 'file:///app/dist/app.js' });

    const result = resolver.resolve('src/app.ts', 10);
    expect(result).toBeNull();
  });

  it('should not use source index when lineNumber is not provided', function () {
    resolver.addScript({ scriptId: '1', url: 'file:///app/dist/bundle.js' });

    let indexCalled = false;
    const smResolver = createMockSourceMapResolver({
      resolveViaSourceIndex: () => {
        indexCalled = true;
        return null;
      },
    });
    resolver.setSourceMapResolver(smResolver);

    // No lineNumber — source index requires line for forward-mapping
    const result = resolver.resolve('src/orders.ts');
    expect(result).toBeNull();
    expect(indexCalled).toBe(false);
  });
});
