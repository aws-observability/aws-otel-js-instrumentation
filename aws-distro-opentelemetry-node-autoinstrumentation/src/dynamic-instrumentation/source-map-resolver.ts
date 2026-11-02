// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as path from 'path';
import { diag } from '@opentelemetry/api';
import {
  TraceMap,
  generatedPositionFor,
  originalPositionFor,
  eachMapping,
  LEAST_UPPER_BOUND,
} from '@jridgewell/trace-mapping';

/**
 * Source map resolver for TypeScript, bundled, and minified code.
 *
 * Loads source maps from V8 scripts (inline or external .map files),
 * builds an index of original source files, and provides:
 * - Forward mapping: original source position → compiled JS position
 * - Reverse mapping: compiled JS position → original source position (for stack traces)
 */

/** Parsed source map info for a single V8 script */
interface SourceMapEntry {
  scriptId: string;
  scriptUrl: string;
  traceMap: TraceMap;
  /** Normalized original source paths from the source map's `sources` array */
  originalSources: string[];
  /** True if source map has name mappings (indicates minified code) */
  hasNameMappings: boolean;
  /** Cached compiled JS source text (loaded lazily for name mapping) */
  compiledSource: string | null;
}

/**
 * Result of forward-mapping an original source position to compiled JS.
 *
 * Line convention: 0-indexed (ready for V8 Debugger API which uses 0-indexed lines).
 * Callers (e.g., BreakpointManager) pass this directly to V8 setBreakpoint.
 */
export interface ForwardMapResult {
  scriptId: string;
  scriptUrl: string;
  line: number; // 0-indexed compiled line (for V8)
  column: number; // 0-indexed compiled column
}

/**
 * Result of reverse-mapping a compiled position to original source.
 *
 * Line convention: 1-indexed (matches user-facing line numbers in editors/stack traces).
 * The trace-mapping library returns 1-indexed lines natively.
 */
export interface ReverseMapResult {
  source: string; // original source file path
  line: number; // 1-indexed original line
  column: number; // 0-indexed original column
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

export class SourceMapResolver {
  /** scriptUrl → SourceMapEntry (for scripts that have source maps) */
  private readonly scriptMaps: Map<string, SourceMapEntry> = new Map();

  /** normalizedOriginalSource → SourceMapEntry (index for Phase 2 lookup) */
  private readonly sourceIndex: Map<string, SourceMapEntry> = new Map();

  /**
   * Load and index a source map for a V8 script.
   *
   * Called when Debugger.scriptParsed provides a sourceMapURL.
   * Supports:
   * - Inline source maps (data:application/json;base64,...)
   * - External .map files (relative to script URL)
   * - Convention-based .map files (scriptUrl + '.map')
   */
  loadSourceMap(scriptId: string, scriptUrl: string, sourceMapURL: string): void {
    try {
      const rawMap = this.loadRawSourceMap(scriptUrl, sourceMapURL);
      if (!rawMap) return;

      const traceMap = new TraceMap(rawMap);
      const sources: string[] = (traceMap as any).sources ?? [];

      // Normalize source paths relative to the script location
      const scriptDir = path.dirname(this.urlToFilePath(scriptUrl));
      const normalizedSources: string[] = sources.map((s: string) => {
        const resolved = path.resolve(scriptDir, s);
        return this.normalizePath(resolved);
      });

      // Check if source map has name mappings (indicates minified code)
      const names: string[] = (traceMap as any).names ?? [];
      const hasNameMappings = names.length > 0;

      // Load compiled source text for name mapping (only for minified code).
      // Skips files larger than 5 MB to avoid excessive memory usage.
      const MAX_COMPILED_SOURCE_SIZE = 5 * 1024 * 1024;
      let compiledSource: string | null = null;
      if (hasNameMappings) {
        try {
          const scriptPath = this.urlToFilePath(scriptUrl);
          const stat = fs.statSync(scriptPath);
          if (stat.size > MAX_COMPILED_SOURCE_SIZE) {
            diag.debug(`DI: Skipping name mapping for ${scriptUrl} — compiled source exceeds 5 MB`);
          } else {
            compiledSource = fs.readFileSync(scriptPath, 'utf-8');
          }
        } catch {
          // Can't read source — name mapping won't work but position mapping still will
        }
      }

      const entry: SourceMapEntry = {
        scriptId,
        scriptUrl,
        traceMap,
        originalSources: normalizedSources,
        hasNameMappings,
        compiledSource,
      };

      this.scriptMaps.set(scriptUrl, entry);

      // Index each original source file for Phase 2 lookup
      for (const normalizedSource of normalizedSources) {
        this.sourceIndex.set(normalizedSource, entry);
      }

      diag.debug(`DI: Loaded source map for ${scriptUrl}: ${normalizedSources.length} sources`);
    } catch (error) {
      diag.warn(`DI: Failed to load source map for ${scriptUrl}: ${error}`);
    }
  }

  /**
   * Check if a script URL has a loaded source map.
   */
  hasSourceMap(scriptUrl: string): boolean {
    return this.scriptMaps.has(scriptUrl);
  }

  /**
   * Forward-map: original source position → compiled JS position.
   *
   * Used when setting breakpoints: user provides TS line, we need JS line.
   *
   * @param scriptUrl The compiled JS script URL (for scripts matched in Phase 1)
   * @param originalSource The original source file path (for source map lookup)
   * @param originalLine 1-indexed line in original source
   * @param originalColumn 0-indexed column (default 0)
   */
  forwardMap(
    scriptUrl: string,
    originalSource: string,
    originalLine: number,
    originalColumn: number = 0
  ): ForwardMapResult | null {
    const entry = this.scriptMaps.get(scriptUrl);
    if (!entry) return null;

    try {
      // Find which source index matches the original file
      const sources: string[] = (entry.traceMap as any).sources ?? [];
      const sourceIdx = sources.findIndex(
        (s: string) =>
          this.normalizePath(path.resolve(path.dirname(this.urlToFilePath(scriptUrl)), s)) ===
          this.normalizePath(originalSource)
      );

      const sourceName = sourceIdx >= 0 ? sources[sourceIdx] : originalSource;

      const result = this.forwardMapPosition(entry.traceMap, sourceName, originalLine, originalColumn);
      if (!result) return null;

      return {
        scriptId: entry.scriptId,
        scriptUrl: entry.scriptUrl,
        line: result.line - 1, // Convert to 0-indexed for V8
        column: result.column,
      };
    } catch (error) {
      diag.debug(`DI: Forward map failed for ${originalSource}:${originalLine}: ${error}`);
      return null;
    }
  }

  /**
   * Find a script via the source map index (Phase 2 lookup).
   *
   * Suffix-matches the filePath against indexed original sources.
   * Returns the compiled script info + forward-mapped position.
   */
  resolveViaSourceIndex(filePath: string, originalLine: number, originalColumn: number = 0): ForwardMapResult | null {
    const normalizedQuery = this.normalizePath(filePath);

    // Suffix-match against all indexed original sources
    let bestMatch: { entry: SourceMapEntry; sourcePath: string; matchLen: number } | null = null;

    for (const [normalizedSource, entry] of this.sourceIndex) {
      const matchLen = this.suffixMatch(normalizedQuery, normalizedSource);
      if (matchLen > 0) {
        if (!bestMatch || matchLen > bestMatch.matchLen) {
          bestMatch = { entry, sourcePath: normalizedSource, matchLen };
        }
      }
    }

    if (!bestMatch) return null;

    // Find the raw source name from the trace map for generatedPositionFor
    const sources: string[] = (bestMatch.entry.traceMap as any).sources ?? [];
    const scriptDir = path.dirname(this.urlToFilePath(bestMatch.entry.scriptUrl));
    let sourceName: string | null = null;

    for (const s of sources) {
      const normalized = this.normalizePath(path.resolve(scriptDir, s));
      if (normalized === bestMatch.sourcePath) {
        sourceName = s;
        break;
      }
    }

    if (!sourceName) return null;

    try {
      const result = this.forwardMapPosition(bestMatch.entry.traceMap, sourceName, originalLine, originalColumn);
      if (!result) return null;

      return {
        scriptId: bestMatch.entry.scriptId,
        scriptUrl: bestMatch.entry.scriptUrl,
        line: result.line - 1, // 0-indexed for V8
        column: result.column ?? 0,
      };
    } catch (error) {
      diag.debug(`DI: Source index forward map failed: ${error}`);
      return null;
    }
  }

  /**
   * Reverse-map: compiled JS position → original source position.
   * Used for stack trace frames.
   */
  reverseMap(scriptUrl: string, compiledLine: number, compiledColumn: number = 0): ReverseMapResult | null {
    const entry = this.scriptMaps.get(scriptUrl);
    if (!entry) return null;

    try {
      const result = originalPositionFor(entry.traceMap, {
        line: compiledLine + 1, // trace-mapping uses 1-indexed lines
        column: compiledColumn,
      });

      if (result.source === null || result.line === null) return null;

      return {
        source: result.source,
        line: result.line,
        column: result.column ?? 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Build a mangled→original name mapping for variables at a breakpoint location.
   *
   * Only works for minified code where the source map has name entries.
   * Scans all source map entries for the original source file, extracts the
   * mangled identifier from the compiled JS at each mapped position, and builds
   * a mapping. When the same mangled name maps to different originals at different
   * lines, picks the one closest to the breakpoint line.
   *
   * Returns null if no name mapping is needed (non-minified code).
   */
  buildNameMapping(scriptUrl: string, originalSourceFile: string, originalLine: number): Record<string, string> | null {
    const entry = this.scriptMaps.get(scriptUrl);
    if (!entry || !entry.hasNameMappings || !entry.compiledSource) return null;

    try {
      const compiledLines = entry.compiledSource.split('\n');
      const sources: string[] = (entry.traceMap as any).sources ?? [];

      // Find source index matching the original file (using suffix matching for
      // relative paths like 'src/orders.ts' against absolute indexed paths)
      const scriptDir = path.dirname(this.urlToFilePath(scriptUrl));
      const normalizedQuery = this.normalizePath(originalSourceFile);
      let targetSource: string | null = null;
      for (const s of sources) {
        const normalized = this.normalizePath(path.resolve(scriptDir, s));
        if (this.suffixMatch(normalizedQuery, normalized) > 0) {
          targetSource = s;
          break;
        }
      }
      if (!targetSource) return null;

      // Collect all named mappings for this source file
      // For each: extract the mangled token from compiled JS
      const candidates: Array<{
        mangledName: string;
        originalName: string;
        originalLine: number;
      }> = [];

      eachMapping(entry.traceMap, (m: any) => {
        if (m.source !== targetSource || !m.name) return;
        if (m.generatedLine < 1) return;

        const lineIdx = m.generatedLine - 1;
        if (lineIdx >= compiledLines.length) return;

        const line = compiledLines[lineIdx];
        const col = m.generatedColumn;
        if (col >= line.length) return;

        // Extract identifier token at this column
        const match = line.substring(col).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
        if (!match) return;

        const mangledName = match[0];
        if (mangledName === m.name) return; // Not actually mangled

        candidates.push({
          mangledName,
          originalName: m.name,
          originalLine: m.originalLine,
        });
      });

      if (candidates.length === 0) return null;

      // Build mapping: for each mangled name, pick the original name from the
      // closest source line to the breakpoint. This handles scope disambiguation
      // (e.g., `e` → `id` in processOrder vs `e` → `x` in calculate).
      const mapping: Record<string, string> = {};
      const bestDistance: Record<string, number> = {};

      for (const c of candidates) {
        const distance = Math.abs(c.originalLine - originalLine);
        if (!(c.mangledName in bestDistance) || distance < bestDistance[c.mangledName]) {
          mapping[c.mangledName] = c.originalName;
          bestDistance[c.mangledName] = distance;
        }
      }

      return Object.keys(mapping).length > 0 ? mapping : null;
    } catch (error) {
      diag.debug(`DI: Failed to build name mapping: ${error}`);
      return null;
    }
  }

  /**
   * Check if a file path has a TypeScript extension.
   */
  isTypeScriptFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return TS_EXTENSIONS.includes(ext);
  }

  clear(): void {
    this.scriptMaps.clear();
    this.sourceIndex.clear();
  }

  /**
   * Forward-map a source position through a TraceMap with fallback.
   *
   * Source maps don't always have mapping entries at column 0 — indented code
   * (e.g., `  return result;`) has its first mapping at the indentation column
   * (col 2), not col 0. A default lookup at col 0 returns null for such lines.
   *
   * Fallback strategy: retry with LEAST_UPPER_BOUND bias, which finds the
   * nearest mapping at or after the requested column. Then reverse-map the
   * result back to the original source and verify it's still on the same line.
   * This prevents cross-line jumps (e.g., targeting a comment line and silently
   * getting the next executable line).
   *
   * Works reliably for TypeScript, minified, and bundled code.
   */
  private forwardMapPosition(
    traceMap: TraceMap,
    sourceName: string,
    originalLine: number,
    originalColumn: number
  ): { line: number; column: number } | null {
    // Try exact match first
    const exact = generatedPositionFor(traceMap, {
      source: sourceName,
      line: originalLine,
      column: originalColumn,
    });

    if (exact.line !== null) {
      return { line: exact.line, column: exact.column ?? 0 };
    }

    // Fallback: LEAST_UPPER_BOUND — finds nearest mapping at or after the column
    const fallback = generatedPositionFor(traceMap, {
      source: sourceName,
      line: originalLine,
      column: originalColumn,
      bias: LEAST_UPPER_BOUND,
    });

    if (fallback.line === null) return null;

    // Verify: reverse-map back to original and check we're still on the same line
    const verification = originalPositionFor(traceMap, {
      line: fallback.line,
      column: fallback.column ?? 0,
    });

    if (verification.line !== originalLine) {
      // LEAST_UPPER_BOUND jumped to a different source line — reject
      return null;
    }

    return { line: fallback.line, column: fallback.column ?? 0 };
  }

  // --- Private helpers ---

  private loadRawSourceMap(scriptUrl: string, sourceMapURL: string): string | null {
    // Inline source map
    if (sourceMapURL.startsWith('data:')) {
      const base64Match = sourceMapURL.match(/base64,(.+)/);
      if (base64Match) {
        return Buffer.from(base64Match[1], 'base64').toString('utf-8');
      }
      return null;
    }

    // External file reference
    const scriptPath = this.urlToFilePath(scriptUrl);
    const mapPath = path.resolve(path.dirname(scriptPath), sourceMapURL);

    if (fs.existsSync(mapPath)) {
      return fs.readFileSync(mapPath, 'utf-8');
    }

    // Convention-based fallback: script.js.map
    const conventionalPath = scriptPath + '.map';
    if (fs.existsSync(conventionalPath)) {
      return fs.readFileSync(conventionalPath, 'utf-8');
    }

    return null;
  }

  private urlToFilePath(url: string): string {
    return url.replace(/^file:\/\/\//, '/').replace(/^file:\/\//, '');
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  }

  private suffixMatch(query: string, target: string): number {
    const q = query.toLowerCase();
    const t = target.toLowerCase();

    let qi = q.length - 1;
    let ti = t.length - 1;
    let matchLen = 0;

    while (qi >= 0 && ti >= 0) {
      if (q[qi] !== t[ti]) break;
      matchLen++;
      qi--;
      ti--;
    }

    if (matchLen === 0) return 0;
    if (qi < 0) {
      if (ti < 0) return matchLen;
      if (t[ti] === '/') return matchLen;
      return 0;
    }
    return 0;
  }
}
