# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
from queue import Queue
from typing import List

from grpc import ServicerContext
from typing_extensions import override

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
    ExportTraceServiceResponse,
)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2_grpc import TraceServiceServicer


class MockCollectorTraceService(TraceServiceServicer):
    _export_requests: Queue = Queue(maxsize=-1)

    def get_requests(self) -> List[ExportTraceServiceRequest]:
        with self._export_requests.mutex:
            return list(self._export_requests.queue)

    def clear_requests(self) -> None:
        with self._export_requests.mutex:
            self._export_requests.queue.clear()

    @override
    # pylint: disable=invalid-name
    def Export(self, request: ExportTraceServiceRequest, context: ServicerContext) -> ExportTraceServiceResponse:
        self._export_requests.put(request)
        return ExportTraceServiceResponse()
