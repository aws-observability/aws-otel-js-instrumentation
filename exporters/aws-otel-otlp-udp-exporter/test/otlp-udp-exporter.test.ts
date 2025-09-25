// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag, SpanContext, SpanKind } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { OTLPUdpSpanExporter, UdpExporter } from '../src/otlp-udp-exporter';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import * as sinon from 'sinon';
import expect from 'expect';
import { Socket } from 'dgram';

describe('UdpExporterTest', () => {
  const endpoint = '127.0.0.1:3000';
  const host = '127.0.0.1';
  const port = 3000;
  let udpExporter: UdpExporter;
  let socketSend: sinon.SinonStub<any[], any>;
  let socketClose: sinon.SinonStub<[callback?: (() => void) | undefined], Socket>;
  let diagErrorSpy: sinon.SinonSpy<[message: string, ...args: unknown[]], void>;

  beforeEach(() => {
    udpExporter = new UdpExporter(endpoint);

    // Stub the _socket methods
    socketSend = sinon.stub(udpExporter['_socket'], 'send');
    socketClose = sinon.stub(udpExporter['_socket'], 'close');

    // Spy on diag.error using sinon
    diagErrorSpy = sinon.spy(diag, 'error');
  });

  afterEach(() => {
    sinon.restore(); // Restore the original dgram behavior
  });

  it('should parse the endpoint correctly', () => {
    expect(udpExporter['_host']).toBe(host);
    expect(udpExporter['_port']).toBe(port);
  });

  it('should send UDP data correctly', () => {
    const data = new Uint8Array([1, 2, 3]);
    const prefix = 'T1';
    const encodedData = '{"format":"json","version":1}\nT1AQID';
    const protbufBinary = Buffer.from(encodedData, 'utf-8');
    udpExporter.sendData(data, prefix);
    sinon.assert.calledOnce(socketSend);
    expect(socketSend.getCall(0).args[0]).toEqual(protbufBinary);
  });

  it('should handle errors when sending UDP data', () => {
    const errorMessage = 'UDP send error';
    socketSend.yields(new Error(errorMessage)); // Simulate an error

    const data = new Uint8Array([1, 2, 3]);
    // Expect the sendData method to throw the error
    expect(() => udpExporter.sendData(data, 'T1')).toThrow(errorMessage);
    // Assert that diag.error was called with the correct error message
    expect(diagErrorSpy.calledOnce).toBe(true);
    expect(diagErrorSpy.calledWith('Error sending UDP data: %s', sinon.match.instanceOf(Error))).toBe(true);
  });

  it('should close the socket on shutdown', () => {
    udpExporter.shutdown();
    expect(socketClose.calledOnce).toBe(true);
  });

  it('should throw when provided invalid endpoint', () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    expect(() => new UdpExporter(123)).toThrow(new Error('Invalid endpoint: 123'));
  });
});

describe('OTLPUdpSpanExporterTest', () => {
  let otlpUdpSpanExporter: OTLPUdpSpanExporter;
  let udpExporterMock: { sendData: any; shutdown: any };
  let diagErrorSpy: sinon.SinonSpy<[message: string, ...args: unknown[]], void>;
  const endpoint = '127.0.0.1:3000';
  const prefix = 'T1';
  const serializedData = new Uint8Array([1, 2, 3]); // Mock serialized data
  // Mock ReadableSpan object
  const mockSpanData: ReadableSpan = {
    name: 'spanName',
    kind: SpanKind.SERVER,
    spanContext: () => {
      const spanContext: SpanContext = {
        traceId: '00000000000000000000000000000008',
        spanId: '0000000000000009',
        traceFlags: 0,
      };
      return spanContext;
    },
    startTime: [0, 0],
    endTime: [0, 1],
    status: { code: 0 },
    attributes: {},
    links: [],
    events: [],
    duration: [0, 1],
    ended: true,
    resource: new Resource({}),
    instrumentationLibrary: { name: 'mockedLibrary' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
  const spans: ReadableSpan[] = [mockSpanData]; // Mock span data

  beforeEach(() => {
    // Mock UdpExporter methods
    udpExporterMock = {
      sendData: sinon.stub(),
      shutdown: sinon.stub().resolves(),
    };

    // Stub the UdpExporter constructor to return our mock
    sinon.stub(UdpExporter.prototype, 'sendData').callsFake(udpExporterMock.sendData);
    sinon.stub(UdpExporter.prototype, 'shutdown').callsFake(udpExporterMock.shutdown);

    // Stub the diag.error method
    diagErrorSpy = sinon.spy(diag, 'error');

    // Create an instance of OTLPUdpSpanExporter
    otlpUdpSpanExporter = new OTLPUdpSpanExporter(endpoint, prefix);
  });

  afterEach(() => {
    // Restore the original functionality after each test
    sinon.restore();
  });

  it('should export spans successfully', () => {
    const callback = sinon.stub();
    // Stub ProtobufTraceSerializer.serializeRequest
    sinon.stub(ProtobufTraceSerializer, 'serializeRequest').returns(serializedData);

    otlpUdpSpanExporter.export(spans, callback);

    expect(udpExporterMock.sendData.calledOnceWith(serializedData, 'T1')).toBe(true);
    expect(callback.calledOnceWith({ code: ExportResultCode.SUCCESS })).toBe(true);
    expect(diagErrorSpy.notCalled).toBe(true); // Ensure no error was logged
  });

  it('should handle serialization failure', () => {
    // Make serializeRequest return null
    sinon.stub(ProtobufTraceSerializer, 'serializeRequest').returns(undefined);
    const callback = sinon.stub();

    otlpUdpSpanExporter.export(spans, callback);

    expect(callback.notCalled).toBe(true);
    expect(udpExporterMock.sendData.notCalled).toBe(true);
    expect(diagErrorSpy.notCalled).toBe(true);
  });

  it('should handle errors during export', () => {
    const error = new Error('Export error');
    udpExporterMock.sendData.throws(error);

    const callback = sinon.stub();

    otlpUdpSpanExporter.export(spans, callback);

    expect(diagErrorSpy.calledOnceWith('Error exporting spans: %s', sinon.match.instanceOf(Error))).toBe(true);
    expect(callback.calledOnceWith({ code: ExportResultCode.FAILED })).toBe(true);
  });

  it('should forceFlush without throwing', async () => {
    expect(otlpUdpSpanExporter.forceFlush()).resolves.not.toThrow();
  });

  it('should shutdown the UDP exporter successfully', async () => {
    await otlpUdpSpanExporter.shutdown();
    expect(udpExporterMock.shutdown.calledOnce).toBe(true);
  });

  it('should use expected Environment Variables to configure endpoint', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'testFunctionName';
    process.env.AWS_XRAY_DAEMON_ADDRESS = 'someaddress:1234';

    const exporter = new OTLPUdpSpanExporter(undefined);
    expect(exporter['_endpoint']).toBe('someaddress:1234');
    expect(exporter['_udpExporter']['_host']).toBe('someaddress');
    expect(exporter['_udpExporter']['_port']).toBe(1234);

    delete process.env.AWS_XRAY_DAEMON_ADDRESS;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });
});
