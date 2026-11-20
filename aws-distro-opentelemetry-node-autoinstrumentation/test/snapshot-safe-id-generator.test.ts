// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { INVALID_SPANID } from '@opentelemetry/api';
import expect from 'expect';
import * as sinon from 'sinon';
import { SnapshotSafeIdGenerator } from '../src/snapshot-safe-id-generator';

const fs = require('fs');
const crypto = require('crypto');

describe('SnapshotSafeIdGenerator', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('generates unique IDs when Math.random() repeats the same sequence', () => {
    // Simulate restoring a snapshot: every "session" sees the same Math.random() value.
    sinon.stub(Math, 'random').returns(0.5);
    const generator = new SnapshotSafeIdGenerator();
    const traceIds = new Set<string>();
    const spanIds = new Set<string>();
    for (let i = 0; i < 20; i++) {
      traceIds.add(generator.generateTraceId());
      spanIds.add(generator.generateSpanId());
    }
    expect(traceIds.size).toBe(20);
    expect(spanIds.size).toBe(20);
  });

  it('does not use Math.random()', () => {
    sinon.stub(Math, 'random').throws(new Error('must not use Math.random'));
    const generator = new SnapshotSafeIdGenerator();
    generator.generateTraceId();
    generator.generateSpanId();
  });

  it('generates X-Ray format trace IDs and valid span IDs', () => {
    const generator = new SnapshotSafeIdGenerator();
    const startTimeSec = Math.floor(Date.now() / 1000);
    const traceId = generator.generateTraceId();
    const spanId = generator.generateSpanId();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(Number(`0x${traceId.substring(0, 8)}`)).toBeGreaterThanOrEqual(startTimeSec);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spanId).not.toBe(INVALID_SPANID);
  });

  it('opens /dev/urandom once and reuses it', () => {
    const openSpy = sinon.spy(fs, 'openSync');
    const generator = new SnapshotSafeIdGenerator();
    for (let i = 0; i < 5; i++) {
      generator.generateTraceId();
      generator.generateSpanId();
    }
    expect(openSpy.withArgs('/dev/urandom', 'r').callCount).toBe(1);
  });

  it('retries an all-zero span ID', () => {
    const readStub = sinon.stub(fs, 'readSync');
    sinon.stub(fs, 'openSync').returns(42);
    readStub.onFirstCall().callsFake((_fd: number, buffer: Buffer) => {
      buffer.fill(0);
      return buffer.length;
    });
    readStub.onSecondCall().callsFake((_fd: number, buffer: Buffer) => {
      buffer.fill(0);
      buffer[buffer.length - 1] = 1;
      return buffer.length;
    });
    expect(new SnapshotSafeIdGenerator().generateSpanId()).toBe('0000000000000001');
  });

  it('falls back to crypto when /dev/urandom is unavailable', () => {
    sinon.stub(fs, 'openSync').throws(new Error('ENOENT'));
    const randomFillSpy = sinon.spy(crypto, 'randomFillSync');
    const generator = new SnapshotSafeIdGenerator();
    expect(generator.generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(generator.generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomFillSpy.called).toBe(true);
  });
});
