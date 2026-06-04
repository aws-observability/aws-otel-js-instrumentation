// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { CompletedRequestsRing } from '../../../src/serviceevents/profiler/completed-requests';

describe('CompletedRequestsRing', function () {
  it('stores and looks up by seq', function () {
    const r = new CompletedRequestsRing(4);
    r.push({ seq: 1, startNs: 100, endNs: 200, operation: 'GET /a' });
    r.push({ seq: 2, startNs: 200, endNs: 300, operation: 'GET /b' });
    expect(r.findBySeq(1)!.operation).toBe('GET /a');
    expect(r.findBySeq(2)!.operation).toBe('GET /b');
    expect(r.findBySeq(3)).toBeUndefined();
  });

  it('evicts oldest entry and drops its seq index', function () {
    const r = new CompletedRequestsRing(2);
    r.push({ seq: 1, startNs: 1, endNs: 2, operation: 'A' });
    r.push({ seq: 2, startNs: 2, endNs: 3, operation: 'B' });
    r.push({ seq: 3, startNs: 3, endNs: 4, operation: 'C' });
    expect(r.findBySeq(1)).toBeUndefined(); // evicted
    expect(r.findBySeq(2)!.operation).toBe('B');
    expect(r.findBySeq(3)!.operation).toBe('C');
  });

  it('snapshot returns entries oldest first, honors size cap', function () {
    const r = new CompletedRequestsRing(3);
    for (let seq = 1; seq <= 5; seq++) {
      r.push({ seq, startNs: seq, endNs: seq + 1, operation: `op${seq}` });
    }
    const snap = r.snapshot();
    expect(snap.length).toBe(3);
    expect(snap.map(x => x.seq)).toEqual([3, 4, 5]);
  });

  it('length tracks size correctly', function () {
    const r = new CompletedRequestsRing(3);
    expect(r.length).toBe(0);
    r.push({ seq: 1, startNs: 1, endNs: 2, operation: 'x' });
    expect(r.length).toBe(1);
    r.push({ seq: 2, startNs: 1, endNs: 2, operation: 'x' });
    r.push({ seq: 3, startNs: 1, endNs: 2, operation: 'x' });
    r.push({ seq: 4, startNs: 1, endNs: 2, operation: 'x' });
    expect(r.length).toBe(3);
  });
});
