# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
import atexit
from concurrent.futures import ThreadPoolExecutor

from grpc import server
from mock_collector_metrics_service import MockCollectorMetricsService
from mock_collector_service import MockCollectorService
from mock_collector_service_pb2_grpc import add_MockCollectorServiceServicer_to_server
from mock_collector_trace_service import MockCollectorTraceService

from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2_grpc import add_MetricsServiceServicer_to_server
from opentelemetry.proto.collector.trace.v1.trace_service_pb2_grpc import add_TraceServiceServicer_to_server


def main() -> None:
    mock_collector_server: server = server(thread_pool=ThreadPoolExecutor(max_workers=10))
    mock_collector_server.add_insecure_port("0.0.0.0:4315")

    trace_collector: MockCollectorTraceService = MockCollectorTraceService()
    metrics_collector: MockCollectorMetricsService = MockCollectorMetricsService()
    mock_collector: MockCollectorService = MockCollectorService(trace_collector, metrics_collector)

    add_TraceServiceServicer_to_server(trace_collector, mock_collector_server)
    add_MetricsServiceServicer_to_server(metrics_collector, mock_collector_server)
    add_MockCollectorServiceServicer_to_server(mock_collector, mock_collector_server)

    mock_collector_server.start()
    atexit.register(mock_collector_server.stop, None)
    print("Ready")
    mock_collector_server.wait_for_termination(None)


if __name__ == "__main__":
    main()
