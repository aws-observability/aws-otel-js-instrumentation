// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Response from the /list-instrumentation-configurations API.
 */
export interface ListConfigurationsResponse {
  Changed: boolean;
  SyncedAt: number | null;
  SyncInterval: number | null;
  LatestConfigurations: Array<Record<string, unknown>>;
  NextToken: string | null;
}

/**
 * Request body for /list-instrumentation-configurations API.
 */
export interface ListConfigurationsRequest {
  Service: string;
  Environment: string;
  InstrumentationType: string;
  SyncedAt?: number;
  NextToken?: string;
}

/**
 * Request body for /report-instrumentation-configuration-status API.
 */
export interface ReportStatusRequest {
  Service: string;
  Environment: string;
  Configurations: StatusEntry[];
}

/**
 * Individual status entry in a status report.
 */
export interface StatusEntry {
  InstrumentationType: string;
  SignalType: string;
  LocationHash: string;
  Status: string;
  Time: number;
  ErrorCause?: string;
}
