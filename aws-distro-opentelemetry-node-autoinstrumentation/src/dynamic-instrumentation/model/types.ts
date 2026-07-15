// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export enum InstrumentationType {
  PROBE = 'PROBE',
  BREAKPOINT = 'BREAKPOINT',
}

export enum ConfigurationStatus {
  READY = 'READY',
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
  ERROR = 'ERROR',
}

// Values must match the service model InstrumentationErrorCause enum
export enum ErrorCause {
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  METHOD_NOT_FOUND = 'METHOD_NOT_FOUND',
  LINE_NOT_EXECUTABLE = 'LINE_NOT_EXECUTABLE',
  OVERLOADED_METHODS = 'OVERLOADED_METHODS',
  LANGUAGE_MISMATCH = 'LANGUAGE_MISMATCH',
  RUNTIME_ERROR = 'RUNTIME_ERROR',
}

export enum DisableReason {
  MAX_HITS_REACHED = 'MAX_HITS_REACHED',
  EXPIRED = 'EXPIRED',
}

export const SNAPSHOT_SIGNAL_TYPE = 'SNAPSHOT';
export const DI_USER_AGENT = 'DynamicInstrumentationClient/1.0';
export const MAX_PAGES_PER_FETCH = 3;
export const MAX_CONFIGS_PER_STATUS_REPORT = 100;
export const SNAPSHOT_QUEUE_CAPACITY = 10_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
