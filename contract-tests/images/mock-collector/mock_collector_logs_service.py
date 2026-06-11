# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
from queue import Queue
from typing import List

from grpc import ServicerContext
from typing_extensions import override

from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest,
    ExportLogsServiceResponse,
)
from opentelemetry.proto.collector.logs.v1.logs_service_pb2_grpc import LogsServiceServicer


class MockCollectorLogsService(LogsServiceServicer):
    _export_requests: Queue = Queue(maxsize=-1)

    def get_requests(self) -> List[ExportLogsServiceRequest]:
        with self._export_requests.mutex:
            return list(self._export_requests.queue)

    def clear_requests(self) -> None:
        with self._export_requests.mutex:
            self._export_requests.queue.clear()

    @override
    # pylint: disable=invalid-name
    def Export(self, request: ExportLogsServiceRequest, context: ServicerContext) -> ExportLogsServiceResponse:
        self._export_requests.put(request)
        return ExportLogsServiceResponse()
