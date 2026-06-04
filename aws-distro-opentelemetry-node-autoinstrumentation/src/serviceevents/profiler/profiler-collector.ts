// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ProfilerCollector — rotates the pprof wall profiler and emits a single
 * OTLP AggregateProfile LogRecord per window.
 *
 * Also feeds a SampleRing that IncidentSnapshotCollector queries.
 */

import { diag } from '@opentelemetry/api';
import { BaseCollector } from '../collectors/base-collector';
import { ServiceEventsOtlpEmitter } from '../exporter/otlp-emitter';
import { WallProfiler, SerializedProfile } from './wall-profiler';
import { convertProfile, toRingSamples, ConvertedSample } from './profile-converter';
import { OtlpProfileBuilder, FrameInfo } from './otlp-profile-builder';
import { SampleRing } from './sample-ring';
import { CompletedRequestsRing } from './completed-requests';
import { isRunningInLambda } from './lambda-guard';

export interface ProfilerCollectorOptions {
  windowSeconds: number;
  intervalMicros: number;
  emitter: ServiceEventsOtlpEmitter | null;
  completedRequests: CompletedRequestsRing;
  sampleRing: SampleRing;
  /**
   * When true, function_table.filename emits the full source path (e.g.
   * /usr/local/lib/.../express/lib/router.js) instead of just the basename
   * (router.js). Default false: matches Java/Python, avoids host-path PII,
   * smaller string_table. Storage delta is bounded by unique file count.
   */
  fullPaths?: boolean;
}

export class ProfilerCollector extends BaseCollector {
  private readonly wall: WallProfiler;
  private readonly emitter: ServiceEventsOtlpEmitter | null;
  private readonly completedRequests: CompletedRequestsRing;
  private readonly sampleRing: SampleRing;
  private readonly intervalMicros: number;
  private readonly windowSeconds: number;
  private readonly fullPaths: boolean;
  private _windowStartMs: number;
  private _pprofReady: boolean = false;

  constructor(opts: ProfilerCollectorOptions) {
    super(opts.windowSeconds * 1000, 'ProfilerCollector');
    this.wall = new WallProfiler({
      intervalMicros: opts.intervalMicros,
      withContexts: true,
      // useCPED omitted — WallProfiler auto-detects (>= Node 22 only).
    });
    this.emitter = opts.emitter;
    this.completedRequests = opts.completedRequests;
    this.sampleRing = opts.sampleRing;
    this.intervalMicros = opts.intervalMicros;
    this.windowSeconds = opts.windowSeconds;
    this.fullPaths = opts.fullPaths ?? false;
    this._windowStartMs = Date.now();
  }

  override start(): void {
    if (isRunningInLambda()) {
      diag.warn('ServiceEvents profiler: AWS Lambda detected; profiler disabled for this runtime');
      return;
    }
    this._pprofReady = this.wall.tryStart();
    if (!this._pprofReady) {
      // WallProfiler logged the reason; swallow start silently so the rest of
      // ServiceEvents continues without the profiler collector's rotation timer.
      return;
    }
    this._windowStartMs = Date.now();
    super.start();
  }

  override stop(): void {
    try {
      super.stop();
    } finally {
      if (this._pprofReady) {
        this.wall.stop();
        this._pprofReady = false;
      }
    }
  }

  collect(): void {
    if (!this._pprofReady) return;

    const now = Date.now();
    const windowStartMs = this._windowStartMs;
    this._windowStartMs = now;

    const profile = this.wall.rotate();
    if (!profile) {
      diag.debug('ProfilerCollector: empty rotate');
      return;
    }

    // Feed raw samples into the incident-enrichment ring (separate from
    // AggregateProfile — see incident_snapshot_collector). This stays a
    // string-formatted-frame path for now since IncidentSnapshot's per-sample
    // shape is a different signal.
    const converted = convertProfile(profile);
    if (converted.length > 0) {
      this.sampleRing.addAll(toRingSamples(converted));
    }

    // Build a single OTLP profile from pprof's tables, with trace/operation
    // attribution per sample via the seq label.
    const builder = this._buildAggregateProfile(profile, windowStartMs);
    if (!builder) return;

    const kept = builder.getFilteredSampleCount();
    if (kept === 0) {
      diag.debug(
        `ProfilerCollector: ${builder.getSampleCount()} raw samples but none had trace/operation attribution; skipping emit`
      );
      return;
    }

    if (this.emitter) {
      // serializeCompressed is async because zstd-codec init is callback-based.
      // Fire-and-forget — emit failures must not propagate to the rotation timer.
      builder
        .serializeCompressed()
        .then(wrapper => {
          this.emitter!.emitOtlpProfile(wrapper);
        })
        .catch(err => {
          diag.debug(`ProfilerCollector: serializeCompressed failed: ${err}`);
        });
    }

    diag.info(
      `ProfilerCollector: emitted profile (raw=${builder.getSampleCount()} kept=${kept} unique_stacks=${builder.getUniqueStackCount()})`
    );
  }

  /**
   * Walk a pprof Profile, intern frames into an OtlpProfileBuilder, and attach
   * trace/operation attribution per sample via the `seq` label → CompletedRequest.
   *
   * Frames must be in ROOT → LEAF order for OtlpProfileBuilder. pprof stores
   * locationId leaf → root, so we reverse on the way in.
   */
  private _buildAggregateProfile(profile: SerializedProfile, windowStartMs: number): OtlpProfileBuilder | null {
    if (!profile.sample || profile.sample.length === 0) return null;

    // Normalize stringTable — @datadog/pprof returns a class with .strings;
    // tests pass a plain array. Handle both.
    const stringTable: string[] = Array.isArray(profile.stringTable)
      ? (profile.stringTable as string[])
      : (profile.stringTable as { strings?: string[] } | undefined)?.strings ?? [];

    const locations = new Map<number, NonNullable<SerializedProfile['location']>[number]>();
    for (const loc of profile.location ?? []) {
      const id = _num(loc?.id);
      if (id !== undefined) locations.set(id, loc);
    }
    const functions = new Map<number, NonNullable<SerializedProfile['function']>[number]>();
    for (const fn of profile.function ?? []) {
      const id = _num(fn?.id);
      if (id !== undefined) functions.set(id, fn);
    }

    const profileEndNs = _num(profile.timeNanos) ?? Date.now() * 1_000_000;
    const profileDurationNs = _num(profile.durationNanos) ?? this.windowSeconds * 1_000_000_000;
    const profileStartNs = profileEndNs - profileDurationNs;
    const periodNs = this.intervalMicros * 1_000;

    const builder = new OtlpProfileBuilder(profileStartNs, profileDurationNs, periodNs);

    for (const sample of profile.sample) {
      const locIds = sample.locationId ?? [];
      if (locIds.length === 0) continue;

      // Resolve frames in root → leaf order.
      const frames: FrameInfo[] = [];
      for (let i = locIds.length - 1; i >= 0; i--) {
        const id = _num(locIds[i]);
        if (id === undefined) continue;
        const loc = locations.get(id);
        if (!loc || !loc.line || loc.line.length === 0) continue;
        // A Location may carry multiple inlined Lines (leaf → caller). Reverse so
        // deepest inlined first, matching root → leaf.
        for (let j = loc.line.length - 1; j >= 0; j--) {
          const line = loc.line[j];
          const fnId = _num(line?.functionId);
          const fn = fnId !== undefined ? functions.get(fnId) : undefined;
          const name = _str(stringTable, _num(fn?.name));
          const sysName = _str(stringTable, _num(fn?.systemName)) || name;
          const rawFile = _str(stringTable, _num(fn?.filename));
          const file = this.fullPaths ? rawFile : _basename(rawFile);
          const lineNo = _num(line?.line) ?? 0;
          const startLine = _num(fn?.startLine) ?? 0;
          if (!name && !file) continue;
          frames.push({
            methodName: name,
            qualifiedName: sysName,
            fileName: file,
            lineNumber: lineNo,
            startLine,
          });
        }
      }
      if (frames.length === 0) continue;

      // Resolve seq → operation + trace context.
      const seq = _extractSeqLabel(sample.label, stringTable);
      let operation: string | undefined;
      let traceId: string | undefined;
      let spanId: string | undefined;
      if (seq !== undefined) {
        const req = this.completedRequests.findBySeq(seq);
        if (req) {
          operation = req.operation;
          traceId = req.traceId;
          spanId = req.spanId;
        }
      }

      // pprof doesn't give a per-sample timestamp; use profile end time minus a
      // bucket offset based on sample order. For windowed profiles this is a
      // best-effort approximation — the spec only requires monotonic-ish offsets.
      const timestampNs = profileEndNs;

      builder.addSample({
        frames,
        timestampNs,
        threadName: undefined, // Node is single-threaded; no per-sample thread.name.
        operation,
        traceId,
        spanId,
      });
    }

    // _windowStartMs informs the rotation timer; callers expect the value to
    // advance after collect(). Surface unused-param to silence TS.
    void windowStartMs;
    return builder;
  }

  /**
   * Drain the current pprof profile into the sample ring WITHOUT emitting an
   * aggregate_profile record or resetting the rotation clock. Intended for
   * on-demand use by the incident-snapshot collector.
   */
  drainIntoSampleRing(): void {
    if (!this._pprofReady) return;
    try {
      const profile = this.wall.rotate();
      const samples = convertProfile(profile);
      if (samples.length === 0) return;
      this.sampleRing.addAll(toRingSamples(samples));
    } catch (err) {
      diag.debug(`ProfilerCollector.drainIntoSampleRing failed: ${err}`);
    }
  }

  /** For tests: expose window tick without the setInterval timer. */
  __test_collect(): void {
    this.collect();
  }

  __test_setReady(ready: boolean): void {
    this._pprofReady = ready;
  }

  /** For tests: ignore the need for a real pprof by feeding synthetic samples. */
  __test_feedSamples(samples: ConvertedSample[]): void {
    this.sampleRing.addAll(toRingSamples(samples));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function _num(v: number | bigint | undefined | null): number | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'number' ? v : Number(v);
}

function _str(table: string[], idx: number | undefined): string {
  if (idx === undefined || idx < 0 || idx >= table.length) return '';
  return table[idx] ?? '';
}

function _basename(path: string): string {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  const j = path.lastIndexOf('\\');
  const sep = Math.max(i, j);
  return sep >= 0 ? path.substring(sep + 1) : path;
}

type SampleLabel = NonNullable<NonNullable<SerializedProfile['sample']>[number]['label']>[number];

function _extractSeqLabel(labels: SampleLabel[] | undefined, stringTable: string[]): number | undefined {
  if (!labels) return undefined;
  for (const lbl of labels) {
    const key = _str(stringTable, _num(lbl.key));
    if (key !== 'seq') continue;
    const numVal = _num(lbl.num);
    if (numVal !== undefined && numVal !== 0) return numVal;
    const strVal = _str(stringTable, _num(lbl.str));
    if (strVal) {
      const parsed = Number(strVal);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}
