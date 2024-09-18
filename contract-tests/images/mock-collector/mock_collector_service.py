# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
from typing import List

from grpc import ServicerContext
from mock_collector_metrics_service import MockCollectorMetricsService
from mock_collector_service_pb2 import (
    ClearRequest,
    ClearResponse,
    GetMetricsRequest,
    GetMetricsResponse,
    GetTracesRequest,
    GetTracesResponse,
)
from mock_collector_service_pb2_grpc import MockCollectorServiceServicer
from mock_collector_trace_service import MockCollectorTraceService
from typing_extensions import override

from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest


class MockCollectorService(MockCollectorServiceServicer):
    """Implements clear, get_traces, and get_metrics for the mock collector.

    Relies on metrics and trace collector services to collect the telemetry.
    """

    def __init__(self, trace_collector: MockCollectorTraceService, metrics_collector: MockCollectorMetricsService):
        super().__init__()
        self.trace_collector: MockCollectorTraceService = trace_collector
        self.metrics_collector: MockCollectorMetricsService = metrics_collector

    @override
    def clear(self, request: ClearRequest, context: ServicerContext) -> ClearResponse:
        self.trace_collector.clear_requests()
        self.metrics_collector.clear_requests()
        return ClearResponse()

    @override
    def get_traces(self, request: GetTracesRequest, context: ServicerContext) -> GetTracesResponse:
        trace_requests: List[ExportTraceServiceRequest] = self.trace_collector.get_requests()
        traces: List[bytes] = list(map(ExportTraceServiceRequest.SerializeToString, trace_requests))
        response: GetTracesResponse = GetTracesResponse(traces=traces)
        return response

    @override
    def get_metrics(self, request: GetMetricsRequest, context: ServicerContext) -> GetMetricsResponse:
        metric_requests: List[ExportMetricsServiceRequest] = self.metrics_collector.get_requests()
        metrics: List[bytes] = list(map(ExportTraceServiceRequest.SerializeToString, metric_requests))
        response: GetMetricsResponse = GetMetricsResponse(metrics=metrics)
        return response
