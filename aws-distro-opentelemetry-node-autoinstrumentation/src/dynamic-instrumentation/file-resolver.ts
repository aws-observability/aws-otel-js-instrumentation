// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { SourceMapResolver } from './source-map-resolver';

/**
 * Represents a loaded V8 script tracked from Debugger.scriptParsed events.
 */
export interface LoadedScript {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
}

/**
 * Result of resolving a file path to a loaded script.
 * If source map resolution was used, resolvedLine/resolvedColumn are set.
 */
export interface ResolvedScript {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  /** 0-indexed compiled line (set when source map forward-mapping was used) */
  resolvedLine?: number;
  /** 0-indexed compiled column (set when source map forward-mapping was used) */
  resolvedColumn?: number;
  /** Whether source map resolution was used */
  sourceMapResolved?: boolean;
}

/**
 * Boundary-aware suffix matching for resolving API file paths against loaded V8 scripts.
 *
 * Compares paths from the end, only matching at path separator boundaries.
 * Example: "services/orderService.js" matches "/app/src/services/orderService.js"
 * but "ice.js" does NOT match "service.js" (no boundary between "serv" and "ice").
 *
 * Excludes node_modules by default.
 * Errors on ambiguous matches (multiple files match same suffix).
 */
export class FileResolver {
  private readonly scripts: Map<string, LoadedScript> = new Map();
  private readonly excludeNodeModules: boolean;
  private sourceMapResolver: SourceMapResolver | null = null;

  constructor(excludeNodeModules: boolean = true) {
    this.excludeNodeModules = excludeNodeModules;
  }

  /**
   * Set the source map resolver for TypeScript/bundled/minified code support.
   */
  setSourceMapResolver(resolver: SourceMapResolver): void {
    this.sourceMapResolver = resolver;
  }

  /**
   * Register a loaded script from Debugger.scriptParsed.
   */
  addScript(script: LoadedScript): void {
    this.scripts.set(script.scriptId, script);
  }

  /**
   * Remove a script (e.g., when unloaded).
   */
  removeScript(scriptId: string): void {
    this.scripts.delete(scriptId);
  }

  /**
   * Resolve a file path from the API to a loaded script.
   *
   * Three-step resolution:
   * Step 1: Suffix-match against V8 script URLs (direct match)
   *   - If match has no source map → use user's line directly
   *   - If match has source map → forward-map through source map
   * Step 2: Suffix-match against source map index (original source files)
   *   - Forward-map original position → compiled position
   * Step 3: TS extension check → FILE_NOT_FOUND if TS file can't be resolved
   *
   * @param filePath The file path from the API config (may be partial)
   * @param lineNumber 1-indexed line number for source map forward-mapping (optional)
   * @param columnNumber 0-indexed column (optional, default 0)
   * @returns The resolved script, or null if not found or ambiguous
   */
  resolve(filePath: string, lineNumber?: number, columnNumber: number = 0): ResolvedScript | null {
    if (!filePath) return null;

    // Step 1: Direct suffix-match against V8 script URLs
    const directMatch = this.directResolve(filePath);

    if (directMatch) {
      // Check if this script has a source map → forward-map through it
      if (this.sourceMapResolver && this.sourceMapResolver.hasSourceMap(directMatch.url) && lineNumber) {
        const fwdResult = this.sourceMapResolver.forwardMap(directMatch.url, filePath, lineNumber, columnNumber);
        if (fwdResult) {
          return {
            scriptId: fwdResult.scriptId,
            url: fwdResult.scriptUrl,
            resolvedLine: fwdResult.line,
            resolvedColumn: fwdResult.column,
            sourceMapResolved: true,
          };
        }
        // Forward-map failed but we have a direct match — fall through to use direct
        diag.debug(`DI: Source map forward-map failed for ${filePath}:${lineNumber}, using direct match`);
      }

      // No source map or no lineNumber — use direct match as-is
      return { scriptId: directMatch.scriptId, url: directMatch.url, sourceMapURL: directMatch.sourceMapURL };
    }

    // Step 2: Suffix-match against source map index (original source files)
    if (this.sourceMapResolver && lineNumber) {
      const indexResult = this.sourceMapResolver.resolveViaSourceIndex(filePath, lineNumber, columnNumber);
      if (indexResult) {
        return {
          scriptId: indexResult.scriptId,
          url: indexResult.scriptUrl,
          resolvedLine: indexResult.line,
          resolvedColumn: indexResult.column,
          sourceMapResolved: true,
        };
      }
    }

    // Step 3: If TS extension and no source map found → FILE_NOT_FOUND
    // (This is handled by the caller checking the return null)
    return null;
  }

  /**
   * Direct suffix-match against V8 script URLs (original Phase 1 logic).
   */
  private directResolve(filePath: string): ResolvedScript | null {
    const normalizedQuery = normalizePath(filePath);
    const matches: Array<{ script: LoadedScript; matchLength: number }> = [];

    for (const script of this.scripts.values()) {
      const scriptUrl = script.url;
      if (!scriptUrl) continue;
      if (this.excludeNodeModules && scriptUrl.includes('/node_modules/')) continue;
      if (!isFileUrl(scriptUrl)) continue;

      const normalizedUrl = normalizePath(scriptUrl);
      const matchLen = boundaryAwareSuffixMatch(normalizedQuery, normalizedUrl);

      if (matchLen > 0) {
        matches.push({ script, matchLength: matchLen });
      }
    }

    if (matches.length === 0) return null;

    if (matches.length === 1) {
      const m = matches[0];
      return { scriptId: m.script.scriptId, url: m.script.url, sourceMapURL: m.script.sourceMapURL };
    }

    matches.sort((a, b) => {
      if (b.matchLength !== a.matchLength) return b.matchLength - a.matchLength;
      return a.script.url.length - b.script.url.length;
    });

    const best = matches[0];
    const secondBest = matches[1];

    if (best.matchLength === secondBest.matchLength) {
      diag.warn(
        `DI: Ambiguous file path '${filePath}' matches multiple scripts: ` +
          `${matches.map(m => m.script.url).join(', ')}. ` +
          'Provide a more specific path to disambiguate.'
      );
      return null;
    }

    return { scriptId: best.script.scriptId, url: best.script.url, sourceMapURL: best.script.sourceMapURL };
  }

  /**
   * Get the URL of a script by its scriptId.
   */
  getScriptUrl(scriptId: string): string {
    return this.scripts.get(scriptId)?.url ?? '';
  }

  getScriptCount(): number {
    return this.scripts.size;
  }

  clear(): void {
    this.scripts.clear();
  }
}

/**
 * Boundary-aware suffix match.
 *
 * Compares characters from the end of both paths.
 * A match is valid only if it starts at a path separator boundary.
 *
 * Returns the length of the matching suffix, or 0 if no match.
 */
export function boundaryAwareSuffixMatch(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let qi = q.length - 1;
  let ti = t.length - 1;
  let matchLen = 0;

  // Compare from end
  while (qi >= 0 && ti >= 0) {
    if (q[qi] !== t[ti]) break;
    matchLen++;
    qi--;
    ti--;
  }

  if (matchLen === 0) return 0;

  // The query must be fully consumed, or the match must start at a boundary
  if (qi < 0) {
    // Full query matched. Check that target has a boundary before the match.
    if (ti < 0) return matchLen; // Both fully consumed — exact match
    if (isSeparator(t[ti])) return matchLen; // Boundary in target
    return 0; // No boundary — partial word match (e.g., "ice.js" matching "service.js")
  }

  // Query not fully consumed — no match
  return 0;
}

function isSeparator(char: string): boolean {
  return char === '/' || char === '\\';
}

/**
 * Normalize a path: strip URL schemes, resolve redundant separators, lowercase.
 */
function normalizePath(p: string): string {
  let normalized = p;
  // Strip common URL schemes
  normalized = normalized.replace(/^file:\/\/\//, '/');
  normalized = normalized.replace(/^file:\/\//, '');
  normalized = normalized.replace(/^webpack:\/\/\//, '');
  normalized = normalized.replace(/^webpack:\/\//, '');
  // Normalize separators
  normalized = normalized.replace(/\\/g, '/');
  // Remove duplicate slashes
  normalized = normalized.replace(/\/+/g, '/');
  return normalized;
}

function isFileUrl(url: string): boolean {
  // Accept file:// URLs, absolute paths, and relative paths
  // Reject: eval, wasm, data:, blob:, etc.
  if (url.startsWith('eval') || url.startsWith('wasm') || url.startsWith('data:') || url.startsWith('blob:')) {
    return false;
  }
  return true;
}
