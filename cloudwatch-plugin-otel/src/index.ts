// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export { SpanMetricsProcessor } from './span-metrics-processor';
export { AlwaysRecordSampler } from './always-record-sampler';
export { buildAttributes } from './span-metrics-attributes-builder';
export { bind, withSpanMetrics } from './span-metrics';
export { SCHEMA_VERSION, LIB_VERSION } from './identity';
