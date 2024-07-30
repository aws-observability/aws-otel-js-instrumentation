// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DiagLogger, Span, SpanAttributes, SpanKind, Tracer } from '@opentelemetry/api';
import {
  AwsSdkInstrumentationConfig,
  NormalizedRequest,
  NormalizedResponse,
} from '@opentelemetry/instrumentation-aws-sdk';

// The OpenTelemetry Authors code
// We need to copy these interfaces that are not exported by Opentelemetry
export interface RequestMetadata {
  // isIncoming - if true, then the operation callback / promise should be bind with the operation's span
  isIncoming: boolean;
  spanAttributes?: SpanAttributes;
  spanKind?: SpanKind;
  spanName?: string;
}

export interface ServiceExtension {
  // called before request is sent, and before span is started
  requestPreSpanHook: (
    request: NormalizedRequest,
    config: AwsSdkInstrumentationConfig,
    diag: DiagLogger
  ) => RequestMetadata;

  // called before request is sent, and after span is started
  requestPostSpanHook?: (request: NormalizedRequest) => void;

  responseHook?: (
    response: NormalizedResponse,
    span: Span,
    tracer: Tracer,
    config: AwsSdkInstrumentationConfig
  ) => void;
}
