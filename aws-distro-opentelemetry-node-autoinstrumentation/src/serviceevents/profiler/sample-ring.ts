// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded ring buffer of raw profiler samples for incident-snapshot enrichment.
 *
 * The ProfilerCollector drains the pprof window on rotation for its aggregate
 * export. Incident snapshots fire synchronously during a request, before the
 * next rotation, so they need a separate, always-up-to-date snapshot source.
 * This ring is updated on each pprof profile rotation (or on each incident
 * trigger's fresh sample capture) and filtered by time range at enrichment time.
 */

export interface RingSample {
  /** Timestamp in nanoseconds since epoch when the sample was captured. */
  timestampNs: number;
  /** Frames root→leaf, formatted as "function(filename:line)". */
  frames: string[];
  /** Optional request seq, set via setProfilerSeq at sample time. */
  seq?: number;
}

export class SampleRing {
  private buf: (RingSample | undefined)[];
  private readonly capacity: number;
  private head: number = 0;
  private size: number = 0;

  constructor(capacity: number = 10_000) {
    this.capacity = capacity;
    this.buf = new Array(capacity);
  }

  add(sample: RingSample): void {
    this.buf[this.head] = sample;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  addAll(samples: RingSample[]): void {
    for (const s of samples) this.add(s);
  }

  /** Return samples whose timestamp falls within [startNs, endNs], oldest first. */
  filterByTimeRange(startNs: number, endNs: number): RingSample[] {
    const out: RingSample[] = [];
    if (this.size === 0) return out;
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      const slot = (start + i) % this.capacity;
      const s = this.buf[slot];
      if (s !== undefined && s.timestampNs >= startNs && s.timestampNs <= endNs) {
        out.push(s);
      }
    }
    return out;
  }

  /** Return samples whose seq matches the given request seq. */
  filterBySeq(seq: number): RingSample[] {
    const out: RingSample[] = [];
    if (this.size === 0) return out;
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      const slot = (start + i) % this.capacity;
      const s = this.buf[slot];
      if (s !== undefined && s.seq === seq) out.push(s);
    }
    return out;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}
