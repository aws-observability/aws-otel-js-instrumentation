// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as inspector from 'inspector';
import { diag } from '@opentelemetry/api';
import { FileResolver } from './file-resolver';
import { SourceMapResolver } from './source-map-resolver';

/**
 * V8 Inspector session manager.
 *
 * Manages the inspector.Session connected to the main thread (from a worker thread)
 * or to the current thread. Enables the Debugger domain, tracks loaded scripts via
 * Debugger.scriptParsed events, and dispatches Debugger.paused events.
 *
 * Uses the callback-based inspector.Session API for Node.js 18 compatibility.
 */
export class InspectorSession {
  private session: inspector.Session | null = null;
  private readonly fileResolver: FileResolver;
  private readonly sourceMapResolver: SourceMapResolver;
  private onPausedCallback: ((params: inspector.Debugger.PausedEventDataType) => void) | null = null;
  private connected: boolean = false;

  constructor(fileResolver: FileResolver, sourceMapResolver: SourceMapResolver) {
    this.fileResolver = fileResolver;
    this.sourceMapResolver = sourceMapResolver;
  }

  /**
   * Connect to the main thread's V8 inspector and enable the Debugger domain.
   *
   * Async because connectToMainThread() delivers Debugger.enable responses and
   * scriptParsed events asynchronously. We must await the enable and yield for
   * scriptParsed events so that FileResolver and SourceMapResolver are populated
   * before the configuration poller attempts to resolve file paths.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    this.session = new inspector.Session();

    // Connect to main thread (from worker) or current thread
    try {
      (this.session as any).connectToMainThread();
    } catch {
      // If connectToMainThread is not available (not in worker), connect to self
      this.session.connect();
    }

    this.connected = true;

    // Listen for script parsed events
    this.session.on('Debugger.scriptParsed', event => {
      const params = event.params;
      if (params.url) {
        this.fileResolver.addScript({
          scriptId: params.scriptId,
          url: params.url,
          sourceMapURL: params.sourceMapURL,
        });

        // Load source map for user app scripts only.
        // Skip node_modules and the ADOT SDK itself — indexing their source maps
        // creates ambiguous suffix matches for common filenames like utils.ts.
        if (
          params.sourceMapURL &&
          !params.url.includes('/node_modules/') &&
          !params.url.includes('aws-distro-opentelemetry-node-autoinstrumentation')
        ) {
          this.sourceMapResolver.loadSourceMap(params.scriptId, params.url, params.sourceMapURL);
        }
      }
    });

    // Listen for paused events
    this.session.on('Debugger.paused', event => {
      if (this.onPausedCallback) {
        try {
          this.onPausedCallback(event.params);
        } catch (error) {
          diag.warn('DI: Error in paused callback', error);
        }
      }
    });

    // Enable debugger and wait for it to complete.
    // With connectToMainThread(), this is asynchronous — the response and subsequent
    // scriptParsed events are delivered via cross-thread messages.
    await this.postAsync('Debugger.enable');

    // Yield to the event loop to allow scriptParsed events to be processed.
    // connectToMainThread() replays one scriptParsed event per already-loaded script,
    // all queued as asynchronous messages. A single yield lets Node.js drain the
    // pending message queue so FileResolver and SourceMapResolver are populated.
    await new Promise<void>(resolve => setImmediate(resolve));

    diag.info(
      `DI: Inspector session connected and Debugger enabled (${this.fileResolver.getScriptCount()} scripts loaded)`
    );
  }

  disconnect(): void {
    if (!this.connected || !this.session) return;

    try {
      this.post('Debugger.disable');
    } catch {
      // Ignore errors during disconnect
    }

    try {
      this.session.disconnect();
    } catch {
      // Ignore
    }

    this.session = null;
    this.connected = false;
    this.fileResolver.clear();
    diag.info('DI: Inspector session disconnected');
  }

  /**
   * Set callback for Debugger.paused events.
   */
  onPaused(callback: (params: inspector.Debugger.PausedEventDataType) => void): void {
    this.onPausedCallback = callback;
  }

  /**
   * Set a breakpoint at a specific location (async — for use outside of pause).
   * Returns the V8 breakpointId, or null if failed.
   */
  async setBreakpointAsync(
    scriptId: string,
    lineNumber: number,
    columnNumber: number = 0,
    scriptUrl?: string
  ): Promise<string | null> {
    try {
      // Use setBreakpointByUrl when URL is available — more reliable for connectToMainThread
      // sessions where setBreakpoint by scriptId may not fire for all line types
      if (scriptUrl) {
        const result = await this.postAsync<any>('Debugger.setBreakpointByUrl', {
          url: scriptUrl,
          lineNumber,
          columnNumber,
        });
        return result?.breakpointId ?? null;
      }

      // Fallback to setBreakpoint by scriptId
      const result = await this.postAsync<inspector.Debugger.SetBreakpointReturnType>('Debugger.setBreakpoint', {
        location: { scriptId, lineNumber, columnNumber },
      });
      return result?.breakpointId ?? null;
    } catch (error) {
      diag.warn(`DI: Failed to set breakpoint at ${scriptId}:${lineNumber}: ${error}`);
      return null;
    }
  }

  /**
   * Remove a breakpoint by its V8 breakpointId (async — for use outside of pause).
   */
  async removeBreakpointAsync(breakpointId: string): Promise<void> {
    try {
      await this.postAsync('Debugger.removeBreakpoint', { breakpointId });
    } catch (error) {
      diag.debug(`DI: Failed to remove breakpoint ${breakpointId}: ${error}`);
    }
  }

  /**
   * Resume execution after a pause (async).
   *
   * CRITICAL: If this fails, the user's code remains frozen. As a last resort,
   * disconnect the inspector session to unfreeze execution.
   */
  async resumeAsync(): Promise<void> {
    try {
      await this.postAsync('Debugger.resume');
    } catch (error) {
      diag.error('DI: CRITICAL - Failed to resume debugger, attempting emergency disconnect', error);
      try {
        this.session?.disconnect();
      } catch {
        // Last resort failed — nothing more we can do
      }
      // Mirror disconnect(): reset state and clear resolver caches so BreakpointManager
      // does not retain stale scriptId references after an emergency disconnect.
      this.session = null;
      this.connected = false;
      this.fileResolver.clear();
    }
  }

  /**
   * Get properties of a remote object (async — for scope chain traversal during pause).
   */
  async getPropertiesAsync(
    objectId: string,
    ownProperties: boolean = true
  ): Promise<inspector.Runtime.PropertyDescriptor[]> {
    try {
      const result = await this.postAsync<inspector.Runtime.GetPropertiesReturnType>('Runtime.getProperties', {
        objectId,
        ownProperties,
        generatePreview: false,
      });
      return result?.result ?? [];
    } catch (error) {
      diag.debug(`DI: Failed to get properties: ${error}`);
      return [];
    }
  }

  /**
   * Evaluate an expression on a paused call frame (async).
   */
  async evaluateOnCallFrameAsync(
    callFrameId: string,
    expression: string
  ): Promise<inspector.Runtime.RemoteObject | null> {
    try {
      const result = await this.postAsync<inspector.Debugger.EvaluateOnCallFrameReturnType>(
        'Debugger.evaluateOnCallFrame',
        {
          callFrameId,
          expression,
          silent: true,
          returnByValue: true,
        }
      );
      return result?.result ?? null;
    } catch (error) {
      diag.debug(`DI: Failed to evaluate on call frame: ${error}`);
      return null;
    }
  }

  // All inspector calls use postAsync — postSync removed because connectToMainThread
  // makes all callbacks asynchronous, even during pause.

  private static readonly INSPECTOR_TIMEOUT_MS: number = 5000;

  private postAsync<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const inspectorCall = new Promise<T>((resolve, reject) => {
      if (!this.session) {
        reject(new Error('Inspector session not connected'));
        return;
      }
      this.session.post(method, params as any, (err: Error | null, res: any) => {
        if (err) reject(err);
        else resolve(res as T);
      });
    });

    // Timeout prevents hanging forever if the inspector callback is never invoked
    // (e.g., worker OOM mid-pause, session disconnected).
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<T>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error(`Inspector call timed out: ${method}`)),
        InspectorSession.INSPECTOR_TIMEOUT_MS
      );
    });

    return Promise.race([inspectorCall, timeout]).finally(() => {
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    });
  }

  private post(method: string, params?: Record<string, unknown>): void {
    if (!this.session) return;
    this.session.post(method, params as any);
  }

  /**
   * Get the file resolver (for looking up script URLs by scriptId).
   */
  getFileResolver(): FileResolver {
    return this.fileResolver;
  }

  /**
   * Get the source map resolver (for reverse-mapping stack frames).
   */
  getSourceMapResolver(): SourceMapResolver {
    return this.sourceMapResolver;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
