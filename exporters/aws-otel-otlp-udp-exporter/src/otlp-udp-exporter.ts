// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as dgram from 'dgram';
import { diag } from '@opentelemetry/api';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';

const DEFAULT_ENDPOINT = '127.0.0.1:2000';
const PROTOCOL_HEADER = '{"format":"json","version":1}\n';
const DEFAULT_FORMAT_OTEL_TRACES_BINARY_PREFIX = 'T1S';

export class UdpExporter {
  private _endpoint: string;
  private _host: string;
  private _port: number;
  private _socket: dgram.Socket;

  constructor(endpoint?: string) {
    this._endpoint = endpoint || DEFAULT_ENDPOINT;
    [this._host, this._port] = this._parseEndpoint(this._endpoint);
    this._socket = dgram.createSocket('udp4');
    this._socket.unref();
  }

  sendData(data: Uint8Array, signalFormatPrefix: string): void {
    const base64EncodedString = Buffer.from(data).toString('base64');
    const message = `${PROTOCOL_HEADER}${signalFormatPrefix}${base64EncodedString}`;

    try {
      this._socket.send(Buffer.from(message, 'utf-8'), this._port, this._host, err => {
        if (err) {
          throw err;
        }
      });
    } catch (err) {
      diag.error('Error sending UDP data: %s', err);
      throw err;
    }
  }

  shutdown(): void {
    this._socket.close();
  }

  private _parseEndpoint(endpoint: string): [string, number] {
    try {
      const [host, port] = endpoint.split(':');
      return [host, parseInt(port, 10)];
    } catch (err) {
      throw new Error(`Invalid endpoint: ${endpoint}`);
    }
  }
}

export class OTLPUdpSpanExporter implements SpanExporter {
  private _udpExporter: UdpExporter;
  private _signalPrefix: string;
  private _endpoint: string;

  constructor(endpoint?: string, _signalPrefix?: string) {
    if (endpoint == null) {
      if (isLambdaEnvironment()) {
        this._endpoint = getXrayDaemonEndpoint() || DEFAULT_ENDPOINT
      } else {
        this._endpoint = DEFAULT_ENDPOINT
      }
    } else {
      this._endpoint = endpoint
    }

    this._udpExporter = new UdpExporter(this._endpoint);
    this._signalPrefix = _signalPrefix || DEFAULT_FORMAT_OTEL_TRACES_BINARY_PREFIX;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const serializedData = ProtobufTraceSerializer.serializeRequest(spans);
    if (serializedData == null) {
      return;
    }
    try {
      this._udpExporter.sendData(serializedData, this._signalPrefix);
      return resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      diag.error('Error exporting spans: %s', err);
      return resultCallback({ code: ExportResultCode.FAILED });
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /** Shutdown exporter. */
  shutdown(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this._udpExporter.shutdown();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }
}

function isLambdaEnvironment() {
  // detect if running in AWS Lambda environment
  return process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;
}

function getXrayDaemonEndpoint() {
  return process.env.AWS_XRAY_DAEMON_ADDRESS;
}