// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Snapshot data model — represents captured runtime data from a breakpoint hit.
 *
 * Written as NDJSON to disk, read by CloudWatch Agent.
 * Format matches the AWS DI Snapshot Spec shared across Java, Python, and JS SDKs.
 */
export interface Snapshot {
  id: string;
  timestamp: number;
  duration: number;
  service: string;
  environment: string;
  locationHash: string;
  instrumentation: SnapshotInstrumentation;
  trace: SnapshotTrace;
  thread: SnapshotThread;
  stack: StackFrame[];
  captures: Captures;
}

export interface SnapshotInstrumentation {
  location: SnapshotLocation;
}

export interface SnapshotLocation {
  codeUnit: string;
  className: string;
  lineNumber: number;
  filePath: string;
  language: string;
}

export interface SnapshotTrace {
  traceId: string;
  spanId: string;
}

export interface SnapshotThread {
  id: number;
  name: string;
}

export interface StackFrame {
  fileName: string;
  function: string;
  lineNumber: number;
}

export interface Captures {
  entry?: CapturedContext;
  return?: CapturedContext;
  lines?: Record<string, CapturedContext>;
}

export interface CapturedContext {
  arguments?: Record<string, CapturedValue>;
  locals?: Record<string, CapturedValue>;
  returnValue?: CapturedValue;
  throwable?: CapturedThrowable;
}

/**
 * Recursive value representation.
 * Each value has a type and exactly one of: value, fields, elements, entries, isNull, notCapturedReason.
 */
export interface CapturedValue {
  type: string;
  value?: string;
  fields?: Record<string, CapturedValue>;
  elements?: CapturedValue[];
  entries?: Array<[CapturedValue, CapturedValue]>;
  isNull?: boolean;
  notCapturedReason?: string;
  truncated?: boolean;
  size?: number;
}

export interface CapturedThrowable {
  type: string;
  message: string;
  stacktrace: StackFrame[];
}
