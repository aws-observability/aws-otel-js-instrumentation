// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-request bookkeeping for the profiler.
 *
 * One process-wide singleton, read by framework hooks at request arrival
 * (assign seq, stamp onto the profiler context holder) and at response end
 * (push the completed-request record with resolved operation). The
 * ProfilerCollector later correlates samples via seq → operation.
 *
 * Designed to work even when the profiler itself is disabled: assigning a
 * seq and pushing completed records is cheap. When the profiler is off the
 * CompletedRequestsRing simply rotates without anyone querying it.
 */

import { context as otelContext, trace } from '@opentelemetry/api';
import { CompletedRequestsRing } from './completed-requests';
import { setProfilerSeq, clearProfilerSeq } from './profiler-context';

let _seqCounter = 0;
let _completedRequests = new CompletedRequestsRing(10_000);

/**
 * Begin tracking a newly-arrived request. Assigns a fresh seq and stamps it
 * onto the profiler context holder so subsequent pprof samples carry the label.
 * Returns the assigned seq (use it when calling endRequest).
 */
export function beginRequest(): number {
  const seq = ++_seqCounter;
  setProfilerSeq(seq);
  return seq;
}

/**
 * Mark a request as finished. Pushes a CompletedRequest entry into the ring so
 * ProfilerCollector can resolve operation + trace context at rotation time.
 * Also clears the profiler holder.
 *
 * Trace context (traceId/spanId) is captured here because the OTel span is
 * still active in framework response hooks — it's the cheapest path to attach
 * trace correlation to profiler samples without threading the IDs through every
 * framework instrumentation.
 */
export function endRequest(seq: number, operation: string, startNs: number, endNs: number): void {
  let traceId: string | undefined;
  let spanId: string | undefined;
  try {
    const span = trace.getSpan(otelContext.active());
    const ctx = span?.spanContext();
    if (ctx && trace.isSpanContextValid(ctx)) {
      traceId = ctx.traceId;
      spanId = ctx.spanId;
    }
  } catch {
    // Telemetry MUST NOT propagate failures into the customer application.
  }
  _completedRequests.push({ seq, operation, startNs, endNs, traceId, spanId });
  clearProfilerSeq();
}

/**
 * Return the singleton ring — ProfilerCollector reads, framework hooks write.
 */
export function getCompletedRequests(): CompletedRequestsRing {
  return _completedRequests;
}

/** For tests: reset all state. */
export function resetRequestTracker(capacity: number = 10_000): void {
  _seqCounter = 0;
  _completedRequests = new CompletedRequestsRing(capacity);
  clearProfilerSeq();
}

/** For tests: inject a specific ring. */
export function __test_setCompletedRequests(ring: CompletedRequestsRing): void {
  _completedRequests = ring;
}

/** For tests: inspect the current seq counter. */
export function __test_getSeqCounter(): number {
  return _seqCounter;
}
