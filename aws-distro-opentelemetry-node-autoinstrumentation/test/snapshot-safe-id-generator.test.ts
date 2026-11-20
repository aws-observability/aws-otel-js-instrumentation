// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { INVALID_SPANID, INVALID_TRACEID } from '@opentelemetry/api';
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

  it('generates valid random trace IDs and span IDs', () => {
    const generator = new SnapshotSafeIdGenerator();
    const traceId = generator.generateTraceId();
    const spanId = generator.generateSpanId();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe(INVALID_TRACEID);
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

  it('retries an all-zero trace ID', () => {
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
    expect(new SnapshotSafeIdGenerator().generateTraceId()).toBe('00000000000000000000000000000001');
  });

  it('uses crypto on platforms without /dev/urandom', () => {
    sinon.stub(fs, 'existsSync').withArgs('/dev/urandom').returns(false);
    const openSpy = sinon.spy(fs, 'openSync');
    const randomFillSpy = sinon.spy(crypto, 'randomFillSync');
    const generator = new SnapshotSafeIdGenerator();
    expect(generator.generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(generator.generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomFillSpy.called).toBe(true);
    expect(openSpy.called).toBe(false);
  });

  it('recovers /dev/urandom after a transient open error', () => {
    const realOpen = fs.openSync;
    const openStub = sinon.stub(fs, 'openSync');
    // Fail both attempts for the first ID (for example EMFILE), then let /dev/urandom open again.
    openStub.onCall(0).throws(Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));
    openStub.onCall(1).throws(Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));
    openStub.callsFake((...args: any[]) => realOpen(...args));
    const randomFillSpy = sinon.spy(crypto, 'randomFillSync');
    const generator = new SnapshotSafeIdGenerator();

    generator.generateSpanId();
    expect(randomFillSpy.callCount).toBe(1);

    generator.generateSpanId();
    generator.generateTraceId();
    expect(randomFillSpy.callCount).toBe(1);
    expect(openStub.callCount).toBe(3);
  });

  it('retries with a new descriptor and closes the failed one after a read error', () => {
    const openStub = sinon.stub(fs, 'openSync');
    openStub.onCall(0).returns(41);
    openStub.onCall(1).returns(42);
    const closeStub = sinon.stub(fs, 'closeSync');
    const readStub = sinon.stub(fs, 'readSync');
    readStub.onFirstCall().throws(Object.assign(new Error('EIO'), { code: 'EIO' }));
    readStub.onSecondCall().callsFake((_fd: number, buffer: Buffer) => {
      buffer.fill(0xab);
      return buffer.length;
    });
    const randomFillSpy = sinon.spy(crypto, 'randomFillSync');

    expect(new SnapshotSafeIdGenerator().generateSpanId()).toBe('abababababababab');
    expect(closeStub.calledOnceWith(41)).toBe(true);
    expect(readStub.secondCall.args[0]).toBe(42);
    expect(randomFillSpy.called).toBe(false);
  });
});
