// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Data models for ServiceEvents telemetry events.
 *
 * Re-exports all data models from sub-modules.
 */

// Resource attributes model
export { ResourceAttributesData, ResourceAttributes, OTEL_KEY_MAP } from './resource-attributes';

// EMF-based telemetry models (function metrics)
export {
  MetricDefinition,
  MetricsStatsEntry,
  CloudWatchMetricDefinition,
  CloudWatchMetricSet,
  CloudWatchMetadata,
  DurationMetrics,
  FunctionCallMetricsData,
  FunctionCallMetrics,
} from './function-telemetry';

// Endpoint telemetry models
export {
  ErrorDetail,
  ErrorBreakdownEntry,
  IncidentExemplar,
  EndpointMetricEventData,
  EndpointMetricEvent,
  EndpointErrorMetric,
} from './endpoint-telemetry';

// Incident snapshot telemetry models
export {
  CallPathEntry,
  ExceptionInfo,
  RequestContext,
  TelemetryCorrelation,
  IncidentSnapshotData,
  IncidentSnapshot,
} from './incident-telemetry';

// Deployment telemetry models (DeploymentContext + DeploymentEvent)
export { DeploymentContextData, DeploymentContext, DeploymentEventTelemetry } from './deployment-telemetry';
