// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  beginRequest,
  endRequest,
  getCompletedRequests,
  resetRequestTracker,
} from '../../../src/serviceevents/profiler/request-tracker';
import { getHolder, resetProfilerContext } from '../../../src/serviceevents/profiler/profiler-context';

describe('request-tracker', function () {
  beforeEach(function () {
    resetRequestTracker();
    resetProfilerContext();
  });

  afterEach(function () {
    resetRequestTracker();
    resetProfilerContext();
  });

  it('beginRequest returns monotonically increasing seqs starting at 1', function () {
    expect(beginRequest()).toBe(1);
    expect(beginRequest()).toBe(2);
    expect(beginRequest()).toBe(3);
  });

  it('beginRequest stamps the seq on the profiler holder', function () {
    const seq = beginRequest();
    expect(getHolder().ref).toEqual({ seq });
  });

  it('endRequest pushes {seq, startNs, endNs, operation} into the completed ring', function () {
    const seq = beginRequest();
    endRequest(seq, 'GET /users/:id', 1_000, 2_000);
    const found = getCompletedRequests().findBySeq(seq);
    expect(found).toBeDefined();
    expect(found!.seq).toBe(seq);
    expect(found!.operation).toBe('GET /users/:id');
    expect(found!.startNs).toBe(1_000);
    expect(found!.endNs).toBe(2_000);
  });

  it('endRequest clears the profiler holder', function () {
    const seq = beginRequest();
    endRequest(seq, 'GET /x', 0, 0);
    expect(getHolder().ref).toBeNull();
  });

  it('resetRequestTracker zeroes the seq counter and empties the ring', function () {
    beginRequest();
    beginRequest();
    endRequest(2, 'POST /y', 0, 0);
    expect(getCompletedRequests().length).toBe(1);

    resetRequestTracker();
    expect(beginRequest()).toBe(1);
    expect(getCompletedRequests().length).toBe(0);
  });

  it('ring survives beyond single-request cycle (profiler can correlate later)', function () {
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const s = beginRequest();
      seqs.push(s);
      endRequest(s, `GET /op${i}`, i * 1000, i * 1000 + 500);
    }
    for (const s of seqs) {
      expect(getCompletedRequests().findBySeq(s)!.operation).toBe(`GET /op${s - 1}`);
    }
  });
});
