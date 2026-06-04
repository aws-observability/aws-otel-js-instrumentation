// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import {
  initProfilerContext,
  setProfilerSeq,
  clearProfilerSeq,
  getHolder,
  resetProfilerContext,
} from '../../../src/serviceevents/profiler/profiler-context';

describe('profiler-context', function () {
  beforeEach(function () {
    resetProfilerContext();
  });

  afterEach(function () {
    resetProfilerContext();
  });

  it('holder starts with ref=null', function () {
    expect(getHolder().ref).toBeNull();
  });

  it('setProfilerSeq mutates holder.ref with a seq', function () {
    setProfilerSeq(7);
    expect(getHolder().ref).toEqual({ seq: 7 });
  });

  it('clearProfilerSeq resets holder.ref to null', function () {
    setProfilerSeq(42);
    expect(getHolder().ref).toEqual({ seq: 42 });
    clearProfilerSeq();
    expect(getHolder().ref).toBeNull();
  });

  it('initProfilerContext invokes pprof setContext exactly once with the holder', function () {
    const setContext = sinon.spy();
    initProfilerContext(setContext);
    expect(setContext.callCount).toBe(1);
    // The argument must be the shared holder so mutations are visible to pprof.
    expect(setContext.firstCall.args[0]).toBe(getHolder());
  });

  it('subsequent setProfilerSeq calls do NOT re-invoke pprof setContext (holder pattern)', function () {
    const setContext = sinon.spy();
    initProfilerContext(setContext);
    setProfilerSeq(1);
    setProfilerSeq(2);
    setProfilerSeq(3);
    // pprof sees each mutation via the shared holder; no additional native calls.
    expect(setContext.callCount).toBe(1);
    expect(getHolder().ref).toEqual({ seq: 3 });
  });

  it('initProfilerContext(null) unbinds without throwing and leaves holder intact', function () {
    setProfilerSeq(9);
    initProfilerContext(null);
    // Holder state is untouched; the module just stops forwarding.
    expect(getHolder().ref).toEqual({ seq: 9 });
  });
});
