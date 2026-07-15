// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AST transformation for automatic function instrumentation.
 *
 * Uses `pirates` to hook into Node.js require() and `acorn` to parse source
 * files, wrapping every function with ServiceEvents monitor enter/exit/exception calls
 * via string splicing (no codegen library needed).
 */

import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { diag } from '@opentelemetry/api';

// Acorn parser — lazy-loaded on first transformSource() call.
let _acorn: any = null;

function _ensureAcornLoaded(): void {
  if (_acorn) return;
  _acorn = require('acorn');
}

// =============================================================================
// Source Map Support
// =============================================================================

interface SourceMapData {
  version: number;
  sources: string[];
  mappings: string;
}

/**
 * Attempt to load and parse a source map for the given JS file.
 *
 * Checks for:
 * 1. Inline source map (//# sourceMappingURL=data:...)
 * 2. External .map file reference (//# sourceMappingURL=file.js.map)
 * 3. Convention-based .map file (file.js.map next to file.js)
 *
 * Returns a lookup function that resolves JS line/column to original source
 * line/column/path, or null if no source map is available.
 */
function _loadSourceMap(
  code: string,
  jsFilePath: string
): ((jsLine: number, jsColumn: number) => { source: string; line: number; name: string | null }) | null {
  try {
    let rawMap: SourceMapData | null = null;

    // Check for sourceMappingURL comment at end of file
    const urlMatch = code.match(/\/\/#\s*sourceMappingURL=(.+?)[\s]*$/m);

    if (urlMatch) {
      const url = urlMatch[1].trim();

      if (url.startsWith('data:')) {
        // Inline source map: data:application/json;base64,...
        const base64Match = url.match(/base64,(.+)/);
        if (base64Match) {
          rawMap = JSON.parse(Buffer.from(base64Match[1], 'base64').toString('utf-8'));
        }
      } else {
        // External file reference
        const mapPath = path.resolve(path.dirname(jsFilePath), url);
        if (fs.existsSync(mapPath)) {
          rawMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
        }
      }
    }

    // Fallback: try conventional .map file
    if (!rawMap) {
      const conventionalPath = jsFilePath + '.map';
      if (fs.existsSync(conventionalPath)) {
        rawMap = JSON.parse(fs.readFileSync(conventionalPath, 'utf-8'));
      }
    }

    if (!rawMap || !rawMap.mappings || !rawMap.sources || rawMap.sources.length === 0) {
      return null;
    }

    // Use Node's built-in module.SourceMap if available (Node 13.7+)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SourceMap } = require('node:module');
    if (!SourceMap) return null;

    const sm = new SourceMap(rawMap);

    return (jsLine: number, jsColumn: number) => {
      const entry = sm.findEntry(jsLine - 1, jsColumn); // SourceMap uses 0-based lines
      if (entry && entry.originalSource) {
        // Resolve source path relative to the map file location
        const originalSource = entry.originalSource.startsWith('file://')
          ? entry.originalSource.replace('file://', '')
          : path.resolve(path.dirname(jsFilePath), entry.originalSource);
        return {
          source: originalSource,
          line: entry.originalLine + 1, // Convert back to 1-based
          name: entry.name ?? null, // Original identifier name if available (e.g., minified 'i' → 'validateUser')
        };
      }
      // Fallback: return JS location as-is
      return { source: jsFilePath, line: jsLine, name: null };
    };
  } catch {
    // Source map resolution is best-effort — don't block instrumentation
    return null;
  }
}

// =============================================================================
// Function Registry
// =============================================================================

export interface FunctionRegistryEntry {
  functionName: string;
  name: string;
  filePath: string;
  line: number;
  isAsync: boolean;
}

/** Global registry mapping function_name (composite) → function metadata. */
const _functionRegistry: Map<string, FunctionRegistryEntry> = new Map();

/**
 * Compute composite function name from file path + local name.
 *
 * Format: "<basename-without-ext>.<name>" (e.g. app.js + handleRequest → "app.handleRequest").
 * On collision (same basename, different dir) we fall back to "<parent-dir>/<basename>.<name>".
 */
export function calculateFunctionName(
  functionName: string,
  filePath: string,
  lineno: number,
  isAsync: boolean = false
): string {
  const basename = path.basename(filePath).replace(/\.(js|mjs|cjs|ts|tsx|mts|cts)$/i, '');
  let composite = `${basename}.${functionName}`;

  const existing = _functionRegistry.get(composite);
  if (existing && existing.filePath !== filePath) {
    const dirName = path.basename(path.dirname(filePath)) || 'root';
    composite = `${dirName}/${basename}.${functionName}`;
  }

  _functionRegistry.set(composite, {
    functionName: composite,
    name: functionName,
    filePath,
    line: lineno,
    isAsync,
  });

  return composite;
}

/** Get a copy of the current function registry. */
export function getFunctionRegistry(): Map<string, FunctionRegistryEntry> {
  return new Map(_functionRegistry);
}

/** Get metadata for a specific function by composite name. */
export function getFunctionInfo(functionName: string): FunctionRegistryEntry | undefined {
  return _functionRegistry.get(functionName);
}

/** Get the number of functions in the registry. */
export function getRegistrySize(): number {
  return _functionRegistry.size;
}

/** Clear the function registry (mainly for testing). */
export function clearFunctionRegistry(): void {
  _functionRegistry.clear();
}

/**
 * Register the function registry callback on globalThis.
 *
 * AST-transformed code calls globalThis.__serviceeventsRegisterFunction(name, localName, path, line, isAsync)
 * at module load time so the main thread's registry is populated even when the
 * transform ran in a separate loader thread (ESM).
 */
export function registerFunctionRegistryGlobal(): void {
  (globalThis as any).__serviceeventsRegisterFunction = (
    functionName: string,
    localName: string,
    filePath: string,
    line: number,
    isAsync: boolean = false
  ) => {
    _functionRegistry.set(functionName, { functionName, name: localName, filePath, line, isAsync });
  };
}

// =============================================================================
// Module Filtering (scope rule 0–4, mirrors Python/Java)
// =============================================================================

/**
 * SDK self-exclusion (SDK_SELF_EXCLUDE) — the non-configurable safety boundary.
 *
 * These path segments cover OpenTelemetry, the ADOT distro, and the transform
 * toolchain itself. A customer cannot opt them back in via PACKAGES_INCLUDE:
 * instrumenting them would recurse (every signal emit / every transform re-enters
 * the matcher) or cause classloader-style cycles.
 *
 * Each entry is matched as a path-segment substring against the resolved file path
 * (see `matchesSelfExclude`). `node_modules/` is deliberately NOT blanket-excluded
 * — with the require-hook's `ignoreNodeModules:false`, customer-published internal
 * packages under `node_modules` (e.g. `node_modules/@mycompany/lib`) must remain
 * instrumentable via PACKAGES_INCLUDE.
 *
 * The transform-toolchain entries are the runtime deps on the matcher/transform
 * hot path: minimatch runs on every matcher invocation, acorn parses every
 * transformed file, pirates is the require-hook lib. Excluding them prevents a
 * broad include from making the toolchain a transform candidate (the re-entrancy
 * guard is the backstop; this is the first-load defense). They are anchored to
 * `/node_modules/<pkg>/` — NOT a bare `/<pkg>/` — because `acorn`/`pirates`/
 * `minimatch` are ordinary words: a bare segment would false-positive on a user
 * source dir named `/app/src/pirates/` or a customer package
 * `node_modules/@mycompany/pirates/`, which (now that node_modules is not
 * blanket-excluded) must stay instrumentable.
 */
export const SDK_SELF_EXCLUDE: readonly string[] = [
  '/@opentelemetry/',
  '/@aws/aws-distro-opentelemetry-node-autoinstrumentation/',
  '/node_modules/acorn/',
  '/node_modules/pirates/',
  '/node_modules/minimatch/',
];

/**
 * Test whether a normalized file path is under an SDK_SELF_EXCLUDE segment.
 *
 * Invariant: `normalizedPath` is always a require()-produced fully-resolved file
 * path (e.g. `/app/node_modules/@opentelemetry/api/index.js`), so the entries are
 * matched as substrings — each is anchored with leading/trailing slashes so a user
 * directory whose name merely ends with one of these can't false-positive.
 */
function matchesSelfExclude(normalizedPath: string): boolean {
  for (const seg of SDK_SELF_EXCLUDE) {
    if (normalizedPath.includes(seg)) {
      return true;
    }
  }
  return false;
}

function matchesAnyGlob(normalizedPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (minimatch(normalizedPath, pattern, { matchBase: true })) {
      return true;
    }
  }
  return false;
}

/**
 * Re-entrancy guard. Set true while a transform is in progress so the matcher
 * short-circuits any require() the transform toolchain itself triggers (acorn /
 * source-map libs lazy-loaded mid-transform). A plain boolean suffices because
 * CJS require() and Module._compile are synchronous and single-threaded — we only
 * need "are we inside a transform", not "which modules" (cf. Python's _currently_loading
 * Set). The ESM loader runs in a separate context with its own flag (see ESM_LOADER_SOURCE).
 *
 * This is a backstop; the primary defense is the transform toolchain being in
 * SDK_SELF_EXCLUDE (so it's never a candidate even on first, non-re-entrant load).
 */
let _inTransform = false;

/**
 * Determine if a file should be transformed.
 *
 * There is no implicit default scope: PACKAGES_INCLUDE is the only way to opt in
 * and PACKAGES_EXCLUDE is the only way to subtract. Decision (highest priority first):
 *   0. Matches SDK_SELF_EXCLUDE (non-configurable), or a transform is in progress → drop
 *   1. PACKAGES_INCLUDE is empty → drop (no implicit default scope)
 *   2. Matches PACKAGES_EXCLUDE → drop
 *   3. Matches PACKAGES_INCLUDE → instrument
 *   4. Otherwise → drop
 *
 * Parameter order is preserved from the original (exclude 2nd, include 3rd) to
 * avoid churn at the call sites.
 *
 * @param filePath - Absolute path to the file
 * @param packagesExclude - User-configured glob patterns to exclude (always wins)
 * @param packagesInclude - User-configured glob patterns to include (empty = instrument nothing)
 * @returns true if the file should be instrumented
 */
export function shouldTransformFile(filePath: string, packagesExclude: string[], packagesInclude: string[]): boolean {
  // Rule 0 (re-entrancy backstop): never recurse into a transform-triggered require().
  if (_inTransform) {
    return false;
  }

  const normalizedPath = filePath.replace(/\\/g, '/');

  // Rule 0: SDK self-exclusion (non-configurable absolute gate). Covers OTel, the
  // ADOT distro, and the transform toolchain — instrumenting any would recurse.
  if (matchesSelfExclude(normalizedPath)) {
    return false;
  }

  // Rule 1: no implicit default scope — empty include means instrument nothing.
  if (packagesInclude.length === 0) {
    return false;
  }

  // Rule 2: user exclude wins over include. Length check first — packagesExclude is
  // empty in the common case, and this is a hot path called once per required module.
  if (packagesExclude.length > 0 && matchesAnyGlob(normalizedPath, packagesExclude)) {
    return false;
  }

  // Rules 3/4: include match → instrument, otherwise drop.
  return matchesAnyGlob(normalizedPath, packagesInclude);
}

// =============================================================================
// Acorn AST Transformation (string-splicing approach)
// =============================================================================

/**
 * Walk an acorn AST and invoke callback for every function node.
 * Passes (fnNode, wrapperNode, parentNode) so name inference works.
 */
function _walkFunctions(
  node: any,
  callback: (fnNode: any, wrapperNode: any, parentNode: any) => void,
  parent: any
): void {
  if (!node || typeof node !== 'object') return;

  const isFn =
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression';

  // MethodDefinition/Property wraps a FunctionExpression or ArrowFunctionExpression in node.value.
  // We handle these specially (passing the wrapper node for name inference) and mark the inner
  // function so it doesn't get visited again during the recursive child walk.
  const isMethod = node.type === 'MethodDefinition' || node.type === 'Property';
  if (
    isMethod &&
    node.value &&
    (node.value.type === 'FunctionExpression' || node.value.type === 'ArrowFunctionExpression')
  ) {
    callback(node.value, node, parent);
    node.value._serviceeventsVisited = true;
  } else if (isFn && !node._serviceeventsVisited) {
    callback(node, node, parent);
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'raw') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && item.type) {
          _walkFunctions(item, callback, node);
        }
      }
    } else if (child && typeof child === 'object' && child.type) {
      _walkFunctions(child, callback, node);
    }
  }
}

/** Infer a function name from the AST context. */
function _inferFunctionName(fnNode: any, wrapperNode: any, parentNode: any): string {
  if (fnNode.id?.name) return fnNode.id.name;
  if (wrapperNode !== fnNode) {
    // MethodDefinition or Property wrapper
    if (wrapperNode.key?.name) return wrapperNode.key.name;
    if (wrapperNode.key?.value) return String(wrapperNode.key.value);
  }
  if (parentNode?.type === 'VariableDeclarator' && parentNode.id?.name) return parentNode.id.name;
  if (parentNode?.type === 'AssignmentExpression' && parentNode.left?.property?.name)
    return parentNode.left.property.name;
  if (parentNode?.type === 'Property' && parentNode.key?.name) return parentNode.key.name;
  return '<anonymous>';
}

/** Escape a string for embedding in a JS string literal. */
function _escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/**
 * Transform source code by wrapping all functions with ServiceEvents monitor calls.
 *
 * Uses acorn for parsing and string splicing for code generation.
 *
 * Before:
 * ```js
 * function processOrder(order) { return db.save(order); }
 * ```
 *
 * After:
 * ```js
 * var __tEnter = globalThis.__serviceeventsMonitorEnter || function(){return null};
 * var __tExit = globalThis.__serviceeventsMonitorExit || function(){};
 * var __tCatch = globalThis.__serviceeventsMonitorException || function(){};
 * globalThis.__serviceeventsRegisterFunction && globalThis.__serviceeventsRegisterFunction("uuid", "processOrder", "/path", 1, false);
 * function processOrder(order) {
 *   var __tCtx;try{__tCtx=__tEnter("uuid")}catch(_e){}
 *   try{ return db.save(order); }
 *   catch(__tErr){try{__tCatch(__tCtx,__tErr)}catch(_e){}throw __tErr}
 *   finally{try{__tExit(__tCtx)}catch(_e){}}
 * }
 * ```
 */
export function transformSource(code: string, filePath: string): string {
  _ensureAcornLoaded();

  let ast: any;
  try {
    ast = _acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      locations: true,
    });
  } catch {
    return code;
  }

  // Attempt to load source map for TS→JS resolution
  const resolveOriginal = _loadSourceMap(code, filePath);

  // Collect all functions with positions for string splicing
  interface FnEntry {
    name: string;
    line: number;
    originalLine: number; // Original source line (TS line if source map exists)
    originalFilePath: string; // Original source file (TS path if source map exists)
    isAsync: boolean;
    functionName: string;
    isExpressionBody: boolean;
    // For block bodies: position of '{' and '}'
    innerStart?: number;
    innerEnd?: number;
    // For arrow expression bodies: position of expression
    exprStart?: number;
    exprEnd?: number;
  }

  const functions: FnEntry[] = [];

  _walkFunctions(
    ast,
    (fnNode: any, wrapperNode: any, parentNode: any) => {
      let name = _inferFunctionName(fnNode, wrapperNode, parentNode);
      const isAsync = !!fnNode.async;
      const line = fnNode.loc?.start?.line ?? 0;
      const column = fnNode.loc?.start?.column ?? 0;

      // Resolve to original source position (e.g., TS line) if source map available.
      // For the name lookup, use the function name identifier position (fnNode.id.start)
      // rather than the function keyword position, since source maps map identifier names.
      let originalLine = line;
      let originalFilePath = filePath;
      if (resolveOriginal) {
        // Use name identifier position for better name resolution in minified code
        const nameCol = fnNode.id?.loc?.start?.column ?? column;
        const nameLine = fnNode.id?.loc?.start?.line ?? line;
        const resolved = resolveOriginal(nameLine, nameCol);
        originalLine = resolved.line;
        originalFilePath = resolved.source;
        // If source map provides original name (e.g., minified 'i' → 'validateUser'), use it
        if (resolved.name && name !== '<anonymous>') {
          name = resolved.name;
        }
      }

      // Use original file path for function name so names are stable across TS→JS compilation
      const composite = calculateFunctionName(name, originalFilePath, originalLine, isAsync);
      const bodyNode = fnNode.body;

      if (fnNode.type === 'ArrowFunctionExpression' && bodyNode.type !== 'BlockStatement') {
        functions.push({
          name,
          line,
          originalLine,
          originalFilePath,
          isAsync,
          functionName: composite,
          isExpressionBody: true,
          exprStart: bodyNode.start,
          exprEnd: bodyNode.end,
        });
      } else if (bodyNode?.type === 'BlockStatement') {
        // Preserve a directive prologue (e.g. "use strict"). Injecting the
        // instrumentation preamble at `{`+1 would push a leading directive out
        // of prologue position, silently demoting it to a no-op string
        // expression and disabling strict mode for the function. Advance
        // innerStart past any leading directive statements so the preamble is
        // inserted after them, keeping the prologue intact.
        let innerStart = bodyNode.start + 1;
        const stmts = bodyNode.body;
        if (Array.isArray(stmts)) {
          for (const stmt of stmts) {
            // acorn always sets `.directive` (the directive's string value) on
            // directive-prologue statements, so that property alone identifies a
            // directive. Relying on it avoids false positives from an arbitrary
            // leading string-literal expression statement (a no-op like `"hello";`),
            // which is not a directive and should not advance innerStart.
            const isDirective = stmt?.type === 'ExpressionStatement' && typeof stmt.directive === 'string';
            if (isDirective && typeof stmt.end === 'number') {
              innerStart = stmt.end;
            } else {
              break;
            }
          }
        }
        functions.push({
          name,
          line,
          originalLine,
          originalFilePath,
          isAsync,
          functionName: composite,
          isExpressionBody: false,
          innerStart,
          innerEnd: bodyNode.end - 1,
        });
      }
    },
    null
  );

  if (functions.length === 0) return code;

  // Build insert-only operations. Each function produces exactly 2 insertions:
  // one at the start of the body and one at the end. Pure insertions don't
  // interfere with each other when applied from end to start, even for nested
  // functions (inner arrows inside outer function bodies).
  const inserts: Array<{ pos: number; text: string }> = [];

  for (const fn of functions) {
    const enterPre = `var __tCtx;try{__tCtx=__tEnter("${_escapeStr(fn.functionName)}")}catch(_e){}try{`;
    const catchFinally =
      '}catch(__tErr){try{__tCatch(__tCtx,__tErr)}catch(_e){}throw __tErr}finally{try{__tExit(__tCtx)}catch(_e){}}';

    if (fn.isExpressionBody) {
      // Arrow expression: () => expr → () => {enterPre return expr catchFinally}
      // Handle parenthesized expressions like () => ({key: val}) where we need
      // to expand past the parens to avoid ({var __tCtx;...}) which is invalid.
      // Expand ALL balanced paren layers (e.g. () => (((  {a:1}  )))), not just
      // one — a single-layer expansion leaves unbalanced parens and emits invalid
      // JS. Tolerate whitespace between the parens and the expression.
      let eStart = fn.exprStart!;
      let eEnd = fn.exprEnd!;
      for (;;) {
        let l = eStart - 1;
        while (l >= 0 && (code[l] === ' ' || code[l] === '\t' || code[l] === '\n' || code[l] === '\r')) {
          l--;
        }
        let r = eEnd;
        while (r < code.length && (code[r] === ' ' || code[r] === '\t' || code[r] === '\n' || code[r] === '\r')) {
          r++;
        }
        if (l >= 0 && code[l] === '(' && r < code.length && code[r] === ')') {
          eStart = l;
          eEnd = r + 1;
        } else {
          break;
        }
      }
      inserts.push({ pos: eStart, text: `{${enterPre}return ` });
      inserts.push({ pos: eEnd, text: `${catchFinally}}` });
    } else if (fn.innerStart! >= fn.innerEnd!) {
      // Empty block body: {} → { enterPre catchFinally }
      // innerStart >= innerEnd when body is empty, so use single insert
      inserts.push({ pos: fn.innerStart!, text: `${enterPre}${catchFinally}` });
    } else {
      // Block body: { body } → { enterPre body catchFinally }
      inserts.push({ pos: fn.innerStart!, text: enterPre });
      inserts.push({ pos: fn.innerEnd!, text: catchFinally });
    }
  }

  // Sort by position ASCENDING, then build result as array of chunks (O(n+m) instead of O(n*m))
  inserts.sort((a, b) => a.pos - b.pos);

  const chunks: string[] = [];
  let lastPos = 0;
  for (const ins of inserts) {
    chunks.push(code.substring(lastPos, ins.pos));
    chunks.push(ins.text);
    lastPos = ins.pos;
  }
  chunks.push(code.substring(lastPos));
  const result = chunks.join('');

  // Build preamble (prepended as a string, no AST construction needed)
  let preamble = 'var __tEnter=globalThis.__serviceeventsMonitorEnter||function(){return null};';
  preamble += 'var __tExit=globalThis.__serviceeventsMonitorExit||function(){};';
  preamble += 'var __tCatch=globalThis.__serviceeventsMonitorException||function(){};';

  // Function registration calls — use original (TS) file path and line if source map resolved
  for (const fn of functions) {
    preamble += `globalThis.__serviceeventsRegisterFunction&&globalThis.__serviceeventsRegisterFunction("${_escapeStr(
      fn.functionName
    )}","${_escapeStr(fn.name)}","${_escapeStr(fn.originalFilePath)}",${fn.originalLine},${fn.isAsync});`;
  }

  // Defense in depth: re-parse the spliced body before shipping it. String
  // splicing can, in rare edge cases (unusual arrow expression bodies, exotic
  // syntax), produce invalid JS. If so, fall back to the ORIGINAL code so a
  // transform bug can never turn a loadable customer module into a SyntaxError
  // at require()/import time. Only the spliced `result` is re-parsed (the
  // preamble is a fixed, known-valid prefix).
  try {
    _acorn.parse(result, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
  } catch (err) {
    diag.warn(
      `ServiceEvents: AST transform produced invalid JS for ${filePath}; ` +
        `using original source (function instrumentation skipped for this module): ${err}`
    );
    return code;
  }

  return preamble + '\n' + result;
}

// =============================================================================
// Pirates Hook Installation
// =============================================================================

/** Revert function returned by pirates (call to uninstall the hook). */
let _revertHook: (() => void) | null = null;

/**
 * Install AST transformation hooks into Node.js require().
 *
 * Uses the `pirates` library to hook into `require()` and transform
 * user source files before they are loaded.
 *
 * @param packagesExclude - Glob patterns for files to exclude (always wins)
 * @param packagesInclude - Glob patterns for files to include (empty = instrument nothing)
 */
export function installAstHooks(packagesExclude: string[] = [], packagesInclude: string[] = []): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { addHook } = require('pirates');

  _revertHook = addHook(
    (code: string, filePath: string) => {
      // Set the re-entrancy guard around the transform: transformSource lazy-require()s
      // its own toolchain (acorn, source-map helpers), which would otherwise re-enter the
      // matcher under a broad include. Reset in finally so a throw can't leave it stuck.
      _inTransform = true;
      try {
        return transformSource(code, filePath);
      } catch {
        // On any error, return original source
        return code;
      } finally {
        _inTransform = false;
      }
    },
    {
      exts: ['.js', '.mjs', '.cjs'],
      // false: scan node_modules so customer-published internal packages become
      // instrumentable via PACKAGES_INCLUDE (Python parity). SDK_SELF_EXCLUDE + the
      // _inTransform guard keep the agent's own code and toolchain from being transformed.
      ignoreNodeModules: false,
      matcher: (filePath: string) => shouldTransformFile(filePath, packagesExclude, packagesInclude),
    }
  );

  // Install a secondary Module._compile wrapper for TypeScript files.
  // When ts-node/tsx compiles .ts → JS, they call Module._compile with the
  // compiled JS but the original .ts filename. Pirates only matches on file
  // extension, so .ts files aren't caught by the hook above. This wrapper
  // runs AFTER ts-node/tsx compilation and transforms the resulting JS.
  _installTsCompileWrapper(packagesExclude, packagesInclude);
}

/** Track whether the TS compile wrapper has been installed. */
let _tsCompileInstalled = false;

/**
 * Wrap Module._compile to intercept TypeScript files compiled by ts-node/tsx.
 * Only transforms files with .ts/.tsx/.mts/.cts extensions that pass through
 * shouldTransformFile. The wrapper checks that the code is valid JS (parseable
 * by acorn) before transforming, since it might see raw TS if no compiler is
 * present.
 */
function _installTsCompileWrapper(packagesExclude: string[], packagesInclude: string[]): void {
  if (_tsCompileInstalled) return;
  _tsCompileInstalled = true;

  const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const origCompile = Module.prototype._compile;

  Module.prototype._compile = function (code: string, filename: string) {
    const ext = path.extname(filename);
    if (TS_EXTS.includes(ext) && shouldTransformFile(filename, packagesExclude, packagesInclude)) {
      // Guard transformSource the same way the pirates callback does — its lazy
      // toolchain require()s must not re-enter the matcher under a broad include.
      _inTransform = true;
      try {
        code = transformSource(code, filename);
      } catch {
        // transformSource failed (e.g., raw TS that acorn can't parse) — use original
      } finally {
        _inTransform = false;
      }
    }
    return origCompile.call(this, code, filename);
  };
}

/**
 * Remove ServiceEvents AST hooks from require().
 */
export function uninstallAstHooks(): void {
  if (_revertHook) {
    _revertHook();
    _revertHook = null;
  }
}

// =============================================================================
// ESM Loader Hook Installation
// =============================================================================

/**
 * ESM loader hooks source code, embedded as a string.
 *
 * This is registered as a data: URL via module.register() so it can run
 * in Node's ESM loader thread without needing a physical .mjs file in the
 * build output.
 *
 * The initialize() hook receives the path to the compiled ast-transformation.js
 * so the loader thread can load the same transformSource/shouldTransformFile
 * functions used by the CJS pirates hook.
 */
const ESM_LOADER_SOURCE = `
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let _transform;
let _shouldTransform;
let _packagesExclude = [];
let _packagesInclude = [];

// Re-entrancy guard, local to this loader context. The CJS module's _inTransform
// does not span the loader context, so the embedded code keeps its own. Set only
// around the synchronous _transform() call below — never around 'await nextLoad',
// or the flag would stay true across the await and suppress unrelated concurrent loads.
let _inTransform = false;

export function initialize(data) {
  const require = createRequire(data.parentUrl);
  const mod = require('./ast-transformation');
  _transform = mod.transformSource;
  _shouldTransform = mod.shouldTransformFile;
  _packagesExclude = data.packagesExclude || [];
  _packagesInclude = data.packagesInclude || [];
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file://')) {
    return nextLoad(url, context);
  }

  // Re-entrancy backstop: if a transform is in progress, don't recurse into a
  // transform-triggered load.
  if (_inTransform) {
    return nextLoad(url, context);
  }

  const filePath = fileURLToPath(url);

  if (!_shouldTransform || !_shouldTransform(filePath, _packagesExclude, _packagesInclude)) {
    return nextLoad(url, context);
  }

  const result = await nextLoad(url, context);

  if (result.format !== 'module') {
    return result;
  }

  const source = typeof result.source === 'string'
    ? result.source
    : new TextDecoder().decode(result.source);

  // Set the guard ONLY around the synchronous _transform call (not the await above).
  _inTransform = true;
  try {
    const transformed = _transform(source, filePath);
    return { ...result, source: transformed };
  } catch {
    return result;
  } finally {
    _inTransform = false;
  }
}
`;

/** Whether ESM hooks have been installed. */
let _esmHooksInstalled = false;

/**
 * Install ESM loader hooks via module.register() (Node.js 20.6+).
 *
 * Registers a loader that intercepts ESM module loading and transforms
 * source files using the same transformSource() function used by the
 * CJS pirates hook.
 *
 * On Node.js versions that don't support module.register(), this is a
 * silent no-op.
 *
 * @param packagesExclude - Glob patterns for files to exclude (always wins)
 * @param packagesInclude - Glob patterns for files to include (empty = instrument nothing)
 */
export function installEsmHooks(packagesExclude: string[] = [], packagesInclude: string[] = []): void {
  if (_esmHooksInstalled) {
    return;
  }

  try {
    // module.register() is only available in Node.js 20.6+
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeModule = require('node:module');
    if (typeof nodeModule.register !== 'function') {
      diag.debug('module.register() not available (Node.js < 20.6), ESM hooks not installed');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pathToFileURL } = require('node:url');

    // parentUrl points to the directory containing the compiled JS files.
    // The loader thread uses createRequire(parentUrl) to load ast-transformation.js.
    const parentUrl = pathToFileURL(path.resolve(__dirname, 'placeholder')).href;

    // Encode loader source as a data: URL
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(ESM_LOADER_SOURCE).toString('base64');

    nodeModule.register(dataUrl, {
      parentURL: parentUrl,
      data: {
        parentUrl,
        packagesExclude,
        packagesInclude,
      },
    });

    _esmHooksInstalled = true;
    diag.info('ESM loader hooks installed via module.register()');
  } catch (err) {
    diag.debug(`Could not install ESM loader hooks: ${err}`);
  }
}
