// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';
import { InspectorSession } from './session';
import { FileResolver } from './file-resolver';
import { SourceMapResolver } from './source-map-resolver';
import { InstrumentationConfiguration, computeRegistryKey } from './model/instrumentation-configuration';
import { ErrorCause } from './model/types';

/** Max retries when file resolution fails for a TypeScript file */
const FILE_RESOLVE_MAX_RETRIES = 2;
/** Delay between retries (ms) — allows late-arriving scriptParsed events to be processed */
const FILE_RESOLVE_RETRY_DELAY_MS = 200;

interface ActiveBreakpoint {
  v8BreakpointId: string;
  registryKey: string;
  scriptId: string;
  lineNumber: number;
  // Source-map-resolved script URL, set only when the breakpoint was placed via a
  // source map. Used by the snapshot collector to build mangled→original name mappings.
  resolvedScriptUrl?: string;
}

/**
 * Maps InstrumentationConfiguration objects to V8 breakpoints.
 *
 * Maintains bidirectional mappings:
 * - registryKey -> ActiveBreakpoint
 * - v8BreakpointId -> registryKey
 *
 * All breakpoint operations are async (V8 Inspector calls are asynchronous
 * outside of Debugger.paused events).
 */
export class BreakpointManager {
  private readonly session: InspectorSession;
  private readonly fileResolver: FileResolver;
  private readonly sourceMapResolver: SourceMapResolver | null;

  // Bidirectional mappings
  private readonly breakpointsByKey: Map<string, ActiveBreakpoint> = new Map();
  private readonly keyByV8Id: Map<string, string> = new Map();

  // Error callback for status reporting
  private onError: ((instrumentationType: string, locationHash: string, errorCause: ErrorCause) => void) | null = null;
  // Success callback for marking config as installed
  private onInstalled: ((registryKey: string) => void) | null = null;

  constructor(session: InspectorSession, fileResolver: FileResolver, sourceMapResolver?: SourceMapResolver) {
    this.session = session;
    this.fileResolver = fileResolver;
    this.sourceMapResolver = sourceMapResolver ?? null;
  }

  setErrorCallback(
    callback: (instrumentationType: string, locationHash: string, errorCause: ErrorCause) => void
  ): void {
    this.onError = callback;
  }

  setInstalledCallback(callback: (registryKey: string) => void): void {
    this.onInstalled = callback;
  }

  /**
   * Add a breakpoint for a configuration (async).
   * Returns true if breakpoint was set successfully.
   */
  async addBreakpoint(config: InstrumentationConfiguration): Promise<boolean> {
    const key = computeRegistryKey(config);

    // Remove existing breakpoint at this key (last writer wins)
    if (this.breakpointsByKey.has(key)) {
      await this.removeBreakpoint(key);
    }

    // JS DI only supports line-level instrumentation (lineNumber > 0)
    if (config.lineNumber <= 0) {
      diag.warn(`DI: Method-level instrumentation (lineNumber=0) not supported in JS. File: ${config.filePath}`);
      this.reportError(config, ErrorCause.RUNTIME_ERROR);
      return false;
    }

    // Resolve file path to loaded script (with source map support).
    // Pass lineNumber for source map forward-mapping (TS line → JS line).
    // For TypeScript files, retry with a short delay if resolution fails — scriptParsed
    // events from connectToMainThread() may still be arriving asynchronously.
    let resolved = this.fileResolver.resolve(config.filePath, config.lineNumber);
    if (!resolved && this.isTypeScriptPath(config.filePath)) {
      for (let retry = 0; retry < FILE_RESOLVE_MAX_RETRIES; retry++) {
        diag.debug(
          `DI: File resolution failed for TS file '${config.filePath}', retry ${retry + 1}/${FILE_RESOLVE_MAX_RETRIES}`
        );
        await new Promise<void>(r => setTimeout(r, FILE_RESOLVE_RETRY_DELAY_MS));
        resolved = this.fileResolver.resolve(config.filePath, config.lineNumber);
        if (resolved) break;
      }
    }
    if (!resolved) {
      diag.warn(`DI: Could not resolve file '${config.filePath}' to any loaded script`);
      this.reportError(config, ErrorCause.FILE_NOT_FOUND);
      return false;
    }

    // Use source-map-resolved line if available, otherwise convert user's 1-indexed line to 0-indexed
    const targetLine: number = resolved.sourceMapResolved ? resolved.resolvedLine! : config.lineNumber - 1;
    const targetColumn: number = resolved.resolvedColumn ?? 0;

    // Resolved script URL for source-map name mapping during snapshot capture.
    // Stored on the ActiveBreakpoint (keyed by registry key) rather than mutated onto the
    // shared config object, which the registry preserves across polling cycles.
    const resolvedScriptUrl: string | undefined = resolved.sourceMapResolved ? resolved.url : undefined;

    // Set the V8 breakpoint (async — callback fires on next tick)
    // Use setBreakpointByUrl for more reliable breakpoint activation with connectToMainThread
    const result = await this.session.setBreakpointAsync(resolved.scriptId, targetLine, targetColumn, resolved.url);
    if (!result) {
      diag.warn(`DI: Failed to set V8 breakpoint at ${config.filePath}:${targetLine + 1}`);
      this.reportError(config, ErrorCause.RUNTIME_ERROR);
      return false;
    }
    const v8Id = result.breakpointId;

    // V8 binds a breakpoint to the nearest executable location. If the target line
    // has no executable code, V8 either binds nothing (resolvedLine null) or slides
    // the breakpoint forward to a different line. In both cases the requested line is
    // not executable, so the config cannot capture where the user asked — report
    // LINE_NOT_EXECUTABLE and remove the breakpoint rather than capture at the wrong
    // line. A column-only adjustment on the same line is normal and not a slide.
    if (result.resolvedLine === null || result.resolvedLine !== targetLine) {
      const resolvedDisplay = result.resolvedLine === null ? 'none' : String(result.resolvedLine + 1);
      diag.warn(
        `DI: Breakpoint at ${config.filePath}:${targetLine + 1} is not on an executable line ` +
          `(V8 resolved to line ${resolvedDisplay}). Reporting LINE_NOT_EXECUTABLE.`
      );
      await this.session.removeBreakpointAsync(v8Id);
      this.reportError(config, ErrorCause.LINE_NOT_EXECUTABLE);
      return false;
    }

    const active: ActiveBreakpoint = {
      v8BreakpointId: v8Id,
      registryKey: key,
      scriptId: resolved.scriptId,
      lineNumber: targetLine,
      resolvedScriptUrl,
    };

    this.breakpointsByKey.set(key, active);
    this.keyByV8Id.set(v8Id, key);

    // Notify that this config is now installed
    if (this.onInstalled) {
      this.onInstalled(key);
    }

    diag.debug(`DI: Set breakpoint at ${config.filePath}:${targetLine + 1} (V8 id: ${v8Id})`);
    return true;
  }

  /**
   * Remove a breakpoint by registry key (async).
   */
  async removeBreakpoint(key: string): Promise<void> {
    const active = this.breakpointsByKey.get(key);
    if (!active) return;

    await this.session.removeBreakpointAsync(active.v8BreakpointId);
    this.breakpointsByKey.delete(key);
    this.keyByV8Id.delete(active.v8BreakpointId);

    diag.debug(`DI: Removed breakpoint (key: ${key}, V8 id: ${active.v8BreakpointId})`);
  }

  /**
   * Look up the registry key for a V8 breakpoint ID (used when Debugger.paused fires).
   */
  getRegistryKeyByV8Id(v8BreakpointId: string): string | undefined {
    return this.keyByV8Id.get(v8BreakpointId);
  }

  /**
   * Source-map-resolved script URL for an active breakpoint, or undefined if the
   * breakpoint was not placed via a source map. Used by the snapshot collector to
   * build mangled→original variable name mappings during capture.
   */
  getResolvedScriptUrl(registryKey: string): string | undefined {
    return this.breakpointsByKey.get(registryKey)?.resolvedScriptUrl;
  }

  /**
   * Remove all breakpoints.
   */
  async removeAll(): Promise<void> {
    const keys = Array.from(this.breakpointsByKey.keys());
    for (const key of keys) {
      await this.removeBreakpoint(key);
    }
  }

  getActiveCount(): number {
    return this.breakpointsByKey.size;
  }

  private reportError(config: InstrumentationConfiguration, cause: ErrorCause): void {
    if (this.onError) {
      this.onError(config.instrumentationType, config.locationHash, cause);
    }
  }

  private isTypeScriptPath(filePath: string): boolean {
    if (this.sourceMapResolver) {
      return this.sourceMapResolver.isTypeScriptFile(filePath);
    }
    const ext = filePath.toLowerCase();
    return ext.endsWith('.ts') || ext.endsWith('.tsx') || ext.endsWith('.mts') || ext.endsWith('.cts');
  }
}
