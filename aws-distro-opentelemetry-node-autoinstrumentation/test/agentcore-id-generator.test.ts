// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as sinon from 'sinon';
import * as proxyquire from 'proxyquire';
import { AgentCoreIdGenerator } from '../src/agentcore-id-generator';

describe('AgentCoreIdGenerator', () => {
  afterEach(() => sinon.restore());

  it('preserves the X-Ray timestamp and reads fresh bytes for every ID', () => {
    sinon.stub(Date, 'now').returns(1700000000000);
    sinon.stub(Math, 'random').throws(new Error('must not use Math.random'));
    const generator = new AgentCoreIdGenerator();
    const traceId = generator.generateTraceId();
    const spanId = generator.generateSpanId();
    assert.match(traceId, /^6553f100[0-9a-f]{24}$/);
    assert.match(spanId, /^[0-9a-f]{16}$/);
    assert.notStrictEqual(traceId, generator.generateTraceId());
    assert.notStrictEqual(spanId, generator.generateSpanId());
  });

  it('creates SDK spans when filesystem instrumentation is enabled', () => {
    const script = `
      const assert = require('assert');
      const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
      const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
      const { FsInstrumentation } = require('@opentelemetry/instrumentation-fs');
      const { AgentCoreIdGenerator } = require(${JSON.stringify(require.resolve('../src/agentcore-id-generator'))});
      const exporter = new InMemorySpanExporter();
      const provider = new NodeTracerProvider({
        idGenerator: new AgentCoreIdGenerator(),
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      provider.register();
      const instrumentation = new FsInstrumentation();
      instrumentation.setTracerProvider(provider);
      const fs = require('fs');
      provider.getTracer('test').startSpan('agent-request').end();
      assert.deepStrictEqual(exporter.getFinishedSpans().map(span => span.name), ['agent-request']);
      const fd = fs.openSync('/dev/null', 'r');
      fs.closeSync(fd);
      assert.ok(exporter.getFinishedSpans().some(span => span.name === 'fs openSync'));
      instrumentation.disable();
      provider.shutdown();
    `;
    const result = spawnSync(
      process.execPath,
      ['--require', require.resolve('ts-node/register/transpile-only'), '-e', script],
      {
        timeout: 10000,
        encoding: 'utf8',
      }
    );
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
  });

  function mockGenerator(read: sinon.SinonStub): { generator: AgentCoreIdGenerator; close: sinon.SinonStub } {
    const close = sinon.stub();
    const open = sinon.stub().withArgs('/dev/urandom', 'r').returns(42);
    const Generator = proxyquire('../src/agentcore-id-generator', {
      fs: { openSync: open, readSync: read, closeSync: close },
    }).AgentCoreIdGenerator;
    return { generator: new Generator(), close };
  }

  it('finishes partial reads before returning an ID', () => {
    const read = sinon.stub().callsFake((fd: number, buffer: Buffer, offset: number, length: number) => {
      assert.strictEqual(fd, 42);
      assert.strictEqual(length, 8 - offset);
      buffer.fill(offset === 0 ? 0x12 : 0x34, offset, offset + 4);
      return 4;
    });
    const { generator, close } = mockGenerator(read);
    assert.strictEqual(generator.generateSpanId(), '1212121234343434');
    sinon.assert.calledTwice(read);
    sinon.assert.calledOnceWithExactly(close, 42);
  });

  it('never returns an all-zero span ID', () => {
    const read = sinon.stub().callsFake((fd: number, buffer: Buffer) => {
      buffer.fill(0);
      return buffer.length;
    });
    const { generator } = mockGenerator(read);
    assert.strictEqual(generator.generateSpanId(), '0000000000000001');
  });

  it('closes the file when reading fails', () => {
    const error = new Error('read failed');
    const { generator, close } = mockGenerator(sinon.stub().throws(error));
    assert.throws(() => generator.generateSpanId(), error);
    sinon.assert.calledOnceWithExactly(close, 42);
  });

  it('rejects an empty read and closes the file', () => {
    const { generator, close } = mockGenerator(sinon.stub().returns(0));
    assert.throws(() => generator.generateTraceId(), /Unable to read random bytes/);
    sinon.assert.calledOnceWithExactly(close, 42);
  });
});
