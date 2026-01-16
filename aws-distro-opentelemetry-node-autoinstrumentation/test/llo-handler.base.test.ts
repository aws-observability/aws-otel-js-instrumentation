// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { EventLogger, EventLoggerProvider } from '@opentelemetry/sdk-events';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { Attributes, SpanContext, SpanKind, TraceFlags } from '@opentelemetry/api';
import { LLOHandler } from '../src/llo-handler';
import * as sinon from 'sinon';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { EventLoggerOptions } from '@opentelemetry/api-events';

// Class with utilities for LLO Handler tests
export class LLOHandlerTestBase {
  public loggerProviderMock: LoggerProvider;
  public eventLoggerMock: EventLogger;
  public eventLoggerProviderMock: EventLoggerProvider;
  public lloHandler: LLOHandler;

  constructor() {
    this.loggerProviderMock = sinon.createStubInstance(LoggerProvider);
    this.lloHandler = new LLOHandler(this.loggerProviderMock);
    this.eventLoggerProviderMock = sinon.stub(this.lloHandler['eventLoggerProvider']);
    this.eventLoggerMock = sinon.createStubInstance(EventLogger);
    this.eventLoggerProviderMock.getEventLogger = (
      name: string,
      version?: string | undefined,
      options?: EventLoggerOptions | undefined
    ) => {
      return this.eventLoggerMock;
    };
  }

  public createMockSpan(attributes: Attributes, kind: SpanKind = SpanKind.INTERNAL): ReadableSpan {
    const spanContext: SpanContext = {
      traceId: '00000000000000000000000000000008',
      spanId: '0000000000000009',
      traceFlags: TraceFlags.SAMPLED,
    };

    const mockSpan: ReadableSpan = {
      name: 'spanName',
      kind,
      spanContext: () => spanContext,
      startTime: [1234567890, 0],
      endTime: [1234567891, 0],
      status: { code: 0 },
      attributes: attributes || {},
      links: [],
      events: [],
      duration: [0, 1],
      ended: true,
      instrumentationScope: { name: 'mockedLibrary', version: '1.0.0' },
      resource: resourceFromAttributes({}),
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };

    return mockSpan;
  }

  public updateMockSpanKey<T>(span: ReadableSpan, key: string, value: T) {
    // Bypass `readonly` restriction of ReadableSpan's attributes.
    (span as any)[key] = value;
  }
}
