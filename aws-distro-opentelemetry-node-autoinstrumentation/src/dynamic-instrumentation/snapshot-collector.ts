// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as inspector from 'inspector';
import * as crypto from 'crypto';
import { diag, isValidTraceId, isValidSpanId } from '@opentelemetry/api';
import { InspectorSession } from './session';
import { BreakpointManager } from './breakpoint-manager';
import { InstrumentationRegistry } from './registry/instrumentation-registry';
import { SnapshotOtlpEmitter } from './snapshot-otlp-emitter';
import { Snapshot, CapturedValue, StackFrame } from './model/snapshot';
import { InstrumentationConfiguration } from './model/instrumentation-configuration';
import { DynamicInstrumentationConfig } from './config';

// Evaluated on the paused main thread's call frame to extract active trace context.
// Uses OTel's global registration symbol (no require() needed). The version '1' in the
// symbol corresponds to @opentelemetry/api major version 1.x. If OTel bumps to a new
// major version, this string must be updated manually.
//
// Readable form:
//   (function() {
//     try {
//       var o = globalThis[Symbol.for('opentelemetry.js.api.1')];
//       if (!o || !o.context) return '{}';
//       var c = o.context.active();
//       if (!c) return '{}';
//       var s = c.getValue(Symbol.for('OpenTelemetry Context Key SPAN'));
//       if (!s) return '{}';
//       var x = s.spanContext();
//       return JSON.stringify({ traceId: x.traceId || '', spanId: x.spanId || '' });
//     } catch (e) { return '{}'; }
//   })()
// Exported so tests can assert the symbol version stays in sync with the installed
// @opentelemetry/api major version.
export const TRACE_CONTEXT_EXPRESSION =
  "(function(){try{var o=globalThis[Symbol.for('opentelemetry.js.api.1')];if(!o||!o.context)return'{}';var c=o.context.active();if(!c)return'{}';var s=c.getValue(Symbol.for('OpenTelemetry Context Key SPAN'));if(!s)return'{}';var x=s.spanContext();return JSON.stringify({traceId:x.traceId||'',spanId:x.spanId||''})}catch(e){return'{}'}})()";

// A valid trace context response is exactly 74 chars (fixed-length JSON with 32+16 hex chars).
// Reject anything over this limit to guard against pathological responses.
const MAX_TRACE_CONTEXT_RESPONSE_LENGTH = 100;

// Timeout for trace extraction evaluation. The IIFE does no I/O — just symbol lookups and
// JSON.stringify — so it should complete in microseconds. Fail fast rather than extending
// the pause duration if something goes wrong.
const TRACE_EXTRACTION_TIMEOUT_MS = 100;

/**
 * Snapshot collector — handles Debugger.paused events.
 *
 * On pause:
 * 1. Identify which config hit this breakpoint
 * 2. Check rate limit and maxHits
 * 3. Collect scope data via async inspector calls (main thread stays paused)
 * 4. Resume execution
 * 5. Serialize and queue snapshot
 *
 * All inspector calls during pause are async (connectToMainThread makes callbacks async
 * even during pause — the main thread is blocked but the worker thread's event loop runs).
 */
export class SnapshotCollector {
  private readonly session: InspectorSession;
  private readonly breakpointManager: BreakpointManager;
  private readonly registry: InstrumentationRegistry;
  private readonly emitter: SnapshotOtlpEmitter;
  private readonly config: DynamicInstrumentationConfig;

  constructor(
    session: InspectorSession,
    breakpointManager: BreakpointManager,
    registry: InstrumentationRegistry,
    emitter: SnapshotOtlpEmitter,
    config: DynamicInstrumentationConfig
  ) {
    this.session = session;
    this.breakpointManager = breakpointManager;
    this.registry = registry;
    this.emitter = emitter;
    this.config = config;
  }

  /**
   * Handle a Debugger.paused event (async).
   * Called by the InspectorSession when a breakpoint is hit.
   */
  async handlePaused(params: inspector.Debugger.PausedEventDataType): Promise<void> {
    const startTime = Date.now();

    try {
      const hitBreakpoints = params.hitBreakpoints ?? [];
      diag.debug(`DI: paused: hitBP=[${hitBreakpoints.join(',')}], fn=${params.callFrames?.[0]?.functionName}`);
      if (hitBreakpoints.length === 0) {
        await this.session.resumeAsync();
        return;
      }

      // Find which config was hit
      const v8BreakpointId = hitBreakpoints[0];
      const registryKey = this.breakpointManager.getRegistryKeyByV8Id(v8BreakpointId);
      if (!registryKey) {
        diag.debug(`DI: no registry key for V8 breakpoint ${v8BreakpointId}`);
        await this.session.resumeAsync();
        return;
      }

      const entry = this.registry.get(registryKey);
      if (!entry) {
        diag.debug(`DI: no registry entry for key ${registryKey}`);
        await this.session.resumeAsync();
        return;
      }

      // Rate limit and maxHits check
      if (!entry.state.recordHit()) {
        await this.session.resumeAsync();
        return;
      }

      // Collect scope data during pause (async — main thread stays paused).
      // The source-map-resolved script URL is tracked by the breakpoint manager (keyed by
      // registry key), not carried on the config object.
      const resolvedScriptUrl = this.breakpointManager.getResolvedScriptUrl(registryKey);
      const rawData = await this.collectRawData(params, entry.config, resolvedScriptUrl);

      // Resume the main thread
      await this.session.resumeAsync();

      // Process after resume — serialize and write
      const duration = Date.now() - startTime;
      this.processSnapshot(entry.config, rawData, duration);
    } catch (error) {
      diag.debug('DI: Error handling paused event', error);
      try {
        await this.session.resumeAsync();
      } catch {
        // Ignore resume errors
      }
    }
  }

  /**
   * Collect scope data during pause via async inspector calls.
   *
   * Filters captured data based on config:
   * - locals: only variables named in CaptureLocals
   * If CaptureLocals is null, skip local capture entirely (do not capture).
   * If CaptureLocals is empty [], capture all from the local scope.
   * If CaptureLocals has values, capture only the named variables.
   */
  private async collectRawData(
    params: inspector.Debugger.PausedEventDataType,
    config: InstrumentationConfiguration,
    resolvedScriptUrl: string | undefined
  ): Promise<RawCaptureData> {
    const callFrames = params.callFrames ?? [];
    const topFrame = callFrames[0];
    const fileResolver = this.session.getFileResolver();

    // Build name mapping for minified code (mangled→original variable names).
    // Only triggers when source map has name entries — zero overhead for non-minified code.
    const sourceMapResolver = this.session.getSourceMapResolver();
    const nameMapping: Record<string, string> | null = resolvedScriptUrl
      ? sourceMapResolver.buildNameMapping(resolvedScriptUrl, config.filePath, config.lineNumber)
      : null;

    // CaptureLocals semantics:
    // null = field absent from API (do not capture locals)
    // [] = capture all from local scope
    // ["a", "b"] = capture only the named variables
    let captureLocals: string[] | null = config.captureConfig?.captureLocals ?? null;

    // Translate CaptureLocals filter from original names to mangled names if name mapping exists.
    // This lets users specify original names (e.g., "total") even for minified code where
    // the runtime variable is mangled (e.g., "r").
    if (nameMapping && captureLocals !== null && captureLocals.length > 0) {
      const reversedMapping: Record<string, string> = {};
      for (const [mangled, original] of Object.entries(nameMapping)) {
        reversedMapping[original] = mangled;
      }
      captureLocals = captureLocals.map(name => reversedMapping[name] ?? name);
    }

    const rawLocals: Record<string, CapturedValue> = {};

    // Only collect locals if captureLocals is not null (null = do not capture)
    if (captureLocals !== null && topFrame) {
      // Only read the local scope (first scope in chain with type 'local')
      // This contains function params + local variables, but NOT module-level vars
      for (const scope of topFrame.scopeChain ?? []) {
        if (scope.type !== 'local') continue;
        if (!scope.object?.objectId) continue;

        const properties = await this.session.getPropertiesAsync(scope.object.objectId);
        for (const prop of properties) {
          if (prop.name === 'this') continue;
          if (!prop.value) continue;

          // Filter by CaptureLocals list (empty = capture all from local scope)
          if (captureLocals.length === 0 || captureLocals.includes(prop.name)) {
            rawLocals[prop.name] = await this.collectValue(prop.value, config);
          }
        }

        break; // Only read the first local scope
      }
    }

    // Apply name mapping: rename mangled variable names to original names
    const locals: Record<string, CapturedValue> = {};
    for (const [name, value] of Object.entries(rawLocals)) {
      const originalName = nameMapping?.[name] ?? name;
      locals[originalName] = value;
    }

    const { traceId, spanId } = await this.extractTraceContext(topFrame);

    // Build stack trace — reverse-map through source maps when available
    const stack: StackFrame[] = callFrames.map(frame => {
      const compiledUrl = frame.url || fileResolver.getScriptUrl(frame.location.scriptId);
      const compiledLine = frame.location?.lineNumber ?? 0;
      const compiledColumn = frame.location?.columnNumber ?? 0;

      // Try to reverse-map to original source location
      const original = sourceMapResolver.reverseMap(compiledUrl, compiledLine, compiledColumn);
      if (original) {
        return {
          fileName: original.source,
          function: frame.functionName || '(anonymous)',
          lineNumber: original.line,
        };
      }

      return {
        fileName: compiledUrl,
        function: frame.functionName || '(anonymous)',
        lineNumber: compiledLine + 1, // V8 is 0-indexed
      };
    });

    return {
      locals,
      stack,
      traceId,
      spanId,
      functionName: topFrame?.functionName ?? '',
      url: topFrame?.url || fileResolver.getScriptUrl(topFrame?.location?.scriptId ?? ''),
      lineNumber: (topFrame?.location?.lineNumber ?? 0) + 1,
    };
  }

  /**
   * Serialize collected data into a Snapshot and queue for writing.
   * Runs AFTER the debugger has resumed.
   */
  private processSnapshot(config: InstrumentationConfiguration, rawData: RawCaptureData, duration: number): void {
    try {
      // All captured data goes into lines.N.locals (JS DI is line-level only)
      const captures: any = {
        lines: {
          [String(config.lineNumber)]: { locals: rawData.locals },
        },
      };

      const snapshot: Snapshot = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        duration,
        service: this.config.serviceName,
        environment: this.config.environment,
        locationHash: config.locationHash,
        instrumentation: {
          location: {
            codeUnit: config.codeUnit ?? '',
            className: config.className ?? '',
            methodName: config.methodName ?? rawData.functionName,
            lineNumber: config.lineNumber,
            filePath: config.filePath ?? rawData.url,
            language: 'javascript',
          },
        },
        trace: {
          traceId: rawData.traceId,
          spanId: rawData.spanId,
        },
        thread: {
          id: 0,
          name: 'main',
        },
        stack:
          config.captureConfig?.captureStackTrace === false
            ? []
            : rawData.stack.slice(0, config.captureConfig?.maxStackFrames ?? 20),
        captures,
      };

      this.emitter.emitSnapshot(snapshot, config.instrumentationType);
    } catch (error) {
      diag.debug('DI: Error processing snapshot', error);
    }
  }

  /**
   * Collect a V8 RemoteObject into a CapturedValue tree during pause.
   * Recursively fetches properties for objects/arrays up to the configured depths.
   *
   * Two independent depth counters mirror the Java SDK semantics:
   * - objectDepth (vs maxObjectDepth) governs plain objects and class instances
   * - collectionDepth (vs maxCollectionDepth) governs Arrays, Maps, and Sets
   * Recursing into a collection increments only collectionDepth; recursing into
   * object fields increments only objectDepth.
   */
  private async collectValue(
    value: inspector.Runtime.RemoteObject,
    config: InstrumentationConfiguration,
    objectDepth: number = 0,
    collectionDepth: number = 0
  ): Promise<CapturedValue> {
    const maxObjDepth: number = config.captureConfig?.maxObjectDepth ?? 3;
    const maxCollDepth: number = config.captureConfig?.maxCollectionDepth ?? 3;
    const maxFields: number = config.captureConfig?.maxFieldsPerObject ?? 20;
    const maxCollWidth: number = config.captureConfig?.maxCollectionWidth ?? 20;
    const maxStrLen: number = config.captureConfig?.maxStringLength ?? 255;

    // Primitives
    if (value.type === 'undefined') return { type: 'undefined', value: 'undefined' };
    if (value.subtype === 'null') return { type: 'null', isNull: true };
    if (value.type === 'string') {
      const s: string = value.value as string;
      if (s.length > maxStrLen) {
        return { type: 'string', value: s.substring(0, maxStrLen), truncated: true, size: s.length };
      }
      return { type: 'string', value: s };
    }
    if (value.type === 'number') {
      const v: string = value.unserializableValue ?? String(value.value);
      return { type: 'number', value: v };
    }
    if (value.type === 'boolean') return { type: 'boolean', value: String(value.value) };
    if (value.type === 'bigint') return { type: 'bigint', value: value.unserializableValue ?? String(value.value) };
    if (value.type === 'symbol') return { type: 'symbol', value: value.description ?? 'Symbol()' };
    if (value.type === 'function')
      return { type: 'function', value: value.description?.split('\n')[0] ?? '(function)' };

    if (!value.objectId) {
      return { type: value.className ?? 'object', value: value.description ?? '{}' };
    }

    // Array
    if (value.subtype === 'array') {
      if (collectionDepth >= maxCollDepth) {
        return { type: 'Array', notCapturedReason: 'depth' };
      }
      const props = await this.session.getPropertiesAsync(value.objectId);
      const elements: CapturedValue[] = [];
      let arrayLen: number = 0;
      for (const p of props) {
        if (p.name === 'length' && p.value) {
          arrayLen = Number(p.value.value) || 0;
          continue;
        }
        if (/^\d+$/.test(p.name) && p.value) {
          if (elements.length >= maxCollWidth) break;
          elements.push(await this.collectValue(p.value, config, objectDepth, collectionDepth + 1));
        }
      }
      return {
        type: 'Array',
        elements,
        size: arrayLen,
        truncated: arrayLen > maxCollWidth,
      };
    }

    // Map
    if (value.className === 'Map') {
      if (collectionDepth >= maxCollDepth) {
        return { type: 'Map', notCapturedReason: 'depth' };
      }
      const props = await this.session.getPropertiesAsync(value.objectId, false);
      const entriesProp = props.find(p => p.name === '[[Entries]]');
      if (entriesProp?.value?.objectId) {
        const entries = await this.session.getPropertiesAsync(entriesProp.value.objectId);
        const captured: Array<[CapturedValue, CapturedValue]> = [];
        let mapSize: number = 0;
        for (const e of entries) {
          if (e.name === 'length') continue;
          if (!/^\d+$/.test(e.name) || !e.value?.objectId) continue;
          mapSize++;
          if (captured.length >= maxCollWidth) continue;
          const kvProps = await this.session.getPropertiesAsync(e.value.objectId);
          const keyProp = kvProps.find(p => p.name === 'key');
          const valProp = kvProps.find(p => p.name === 'value');
          if (keyProp?.value && valProp?.value) {
            captured.push([
              await this.collectValue(keyProp.value, config, objectDepth, collectionDepth + 1),
              await this.collectValue(valProp.value, config, objectDepth, collectionDepth + 1),
            ]);
          }
        }
        return { type: 'Map', entries: captured, size: mapSize, truncated: mapSize > maxCollWidth };
      }
      return { type: 'Map', value: value.description ?? 'Map(?)' };
    }

    // Set
    if (value.className === 'Set') {
      if (collectionDepth >= maxCollDepth) {
        return { type: 'Set', notCapturedReason: 'depth' };
      }
      const props = await this.session.getPropertiesAsync(value.objectId, false);
      const entriesProp = props.find(p => p.name === '[[Entries]]');
      if (entriesProp?.value?.objectId) {
        const entries = await this.session.getPropertiesAsync(entriesProp.value.objectId);
        const elements: CapturedValue[] = [];
        let setSize: number = 0;
        for (const e of entries) {
          if (e.name === 'length') continue;
          if (!/^\d+$/.test(e.name) || !e.value?.objectId) continue;
          setSize++;
          if (elements.length >= maxCollWidth) continue;
          const valProps = await this.session.getPropertiesAsync(e.value.objectId);
          const valProp = valProps.find(p => p.name === 'value');
          if (valProp?.value) {
            elements.push(await this.collectValue(valProp.value, config, objectDepth, collectionDepth + 1));
          }
        }
        return { type: 'Set', elements, size: setSize, truncated: setSize > maxCollWidth };
      }
      return { type: 'Set', value: value.description ?? 'Set(?)' };
    }

    // Date, RegExp, Error — use description
    if (value.className === 'Date' || value.className === 'RegExp') {
      return { type: value.className, value: value.description ?? '' };
    }
    if (value.subtype === 'error') {
      return { type: value.className ?? 'Error', value: value.description ?? '' };
    }

    // Plain object (or class instance) — check object depth limit
    if (objectDepth >= maxObjDepth) {
      return { type: value.className ?? 'object', notCapturedReason: 'depth' };
    }

    const props = await this.session.getPropertiesAsync(value.objectId);
    const fields: Record<string, CapturedValue> = {};
    let fieldCount: number = 0;
    let totalFields: number = 0;
    for (const p of props) {
      if (p.name === '__proto__') continue;
      totalFields++;
      if (fieldCount >= maxFields) continue;
      if (p.value) {
        fields[p.name] = await this.collectValue(p.value, config, objectDepth + 1, collectionDepth);
        fieldCount++;
      }
    }
    const result: CapturedValue = { type: value.className ?? 'Object', fields };
    if (totalFields > maxFields) {
      result.truncated = true;
      result.size = totalFields;
    }
    return result;
  }

  /**
   * Extract trace context from the paused main thread via evaluateOnCallFrame.
   * Accesses OTel's globally-registered context manager through well-known symbols
   * (no require() needed). Returns empty strings if OTel is not present or no span is active.
   *
   * This method MUST NOT throw — any failure degrades gracefully to empty trace fields.
   */
  private async extractTraceContext(
    topFrame: inspector.Debugger.CallFrame | undefined
  ): Promise<{ traceId: string; spanId: string }> {
    const empty = { traceId: '', spanId: '' };

    try {
      if (!topFrame?.callFrameId) return empty;

      const result = await new Promise<inspector.Runtime.RemoteObject | null>(resolve => {
        const timer = setTimeout(() => resolve(null), TRACE_EXTRACTION_TIMEOUT_MS);
        this.session
          .evaluateOnCallFrameAsync(topFrame.callFrameId, TRACE_CONTEXT_EXPRESSION)
          .then(res => {
            clearTimeout(timer);
            resolve(res);
          })
          .catch(() => {
            clearTimeout(timer);
            resolve(null);
          });
      });

      if (!result || result.type !== 'string' || !result.value) return empty;

      const responseStr = result.value as string;
      if (responseStr.length > MAX_TRACE_CONTEXT_RESPONSE_LENGTH) return empty;

      const parsed = JSON.parse(responseStr);
      if (
        typeof parsed.traceId === 'string' &&
        typeof parsed.spanId === 'string' &&
        isValidTraceId(parsed.traceId) &&
        isValidSpanId(parsed.spanId)
      ) {
        return { traceId: parsed.traceId, spanId: parsed.spanId };
      }
    } catch (error) {
      diag.debug('DI: Failed to extract trace context from paused frame', error);
    }

    return empty;
  }
}

interface RawCaptureData {
  locals: Record<string, CapturedValue>;
  stack: StackFrame[];
  traceId: string;
  spanId: string;
  functionName: string;
  url: string;
  lineNumber: number;
}
