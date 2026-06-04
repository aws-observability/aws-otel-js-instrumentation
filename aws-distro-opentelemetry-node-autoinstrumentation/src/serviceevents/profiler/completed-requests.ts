// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded ring of completed HTTP requests, keyed by a monotonic sequence id.
 *
 * Framework hooks push an entry at response-end time (where route pattern
 * resolution is reliable across Express/Fastify/Koa/Next.js). The profiler
 * looks up the operation at window rotation via `findBySeq(seq)`, using seq
 * labels that pprof stamped onto each sample via `setProfilerSeq`.
 */

export interface CompletedRequest {
  seq: number;
  startNs: number;
  endNs: number;
  operation: string;
  /** Trace ID (32 lowercase hex) of the OTel span active during the request, or empty if untraced. */
  traceId?: string;
  /** Span ID (16 lowercase hex), or empty if untraced. */
  spanId?: string;
}

export class CompletedRequestsRing {
  private buf: (CompletedRequest | undefined)[];
  private readonly capacity: number;
  private head: number = 0;
  private size: number = 0;
  // Index from seq → buffer slot, for O(1) lookup. Cleared when slot is evicted.
  private seqIndex: Map<number, number> = new Map();

  constructor(capacity: number = 10_000) {
    this.capacity = capacity;
    this.buf = new Array(capacity);
  }

  push(req: CompletedRequest): void {
    const slot = this.head;
    // Evicting an old entry: remove its seq-index mapping.
    const old = this.buf[slot];
    if (old !== undefined) {
      // Only drop the index if it still points to this slot (defensive).
      if (this.seqIndex.get(old.seq) === slot) {
        this.seqIndex.delete(old.seq);
      }
    }
    this.buf[slot] = req;
    this.seqIndex.set(req.seq, slot);
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  findBySeq(seq: number): CompletedRequest | undefined {
    const slot = this.seqIndex.get(seq);
    if (slot === undefined) return undefined;
    const req = this.buf[slot];
    // Guard against stale index after wraparound.
    if (req === undefined || req.seq !== seq) return undefined;
    return req;
  }

  /** Snapshot of all currently-held entries (oldest first). */
  snapshot(): CompletedRequest[] {
    const out: CompletedRequest[] = [];
    if (this.size === 0) return out;
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      const slot = (start + i) % this.capacity;
      const req = this.buf[slot];
      if (req !== undefined) out.push(req);
    }
    return out;
  }

  get length(): number {
    return this.size;
  }
}
