# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
import atexit
import gzip
import io
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler

from socketserver import ThreadingTCPServer

from grpc import server
from mock_collector_logs_service import MockCollectorLogsService
from mock_collector_metrics_service import MockCollectorMetricsService
from mock_collector_service import MockCollectorService
from mock_collector_service_pb2_grpc import add_MockCollectorServiceServicer_to_server
from mock_collector_trace_service import MockCollectorTraceService

from google.protobuf.json_format import Parse as proto_json_parse
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest, ExportLogsServiceResponse
from opentelemetry.proto.collector.logs.v1.logs_service_pb2_grpc import add_LogsServiceServicer_to_server
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import (
    ExportMetricsServiceRequest,
    ExportMetricsServiceResponse,
)
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2_grpc import add_MetricsServiceServicer_to_server
from opentelemetry.proto.collector.trace.v1.trace_service_pb2_grpc import add_TraceServiceServicer_to_server

# Port for OTLP/gRPC (used by Application Signals)
_GRPC_PORT = 4315
# Port for OTLP/HTTP (used by DI snapshot emitter + ServiceEvents)
_HTTP_PORT = 4318


def _read_chunked(rfile):
    """Read an HTTP chunked transfer-encoded body from *rfile* and return
    the reassembled bytes.  Handles the ``Transfer-Encoding: chunked``
    framing that Node.js ``http.request`` sends by default when no
    explicit ``Content-Length`` header is set."""
    body = io.BytesIO()
    while True:
        line = rfile.readline()
        if not line:
            break
        chunk_size = int(line.strip(), 16)
        if chunk_size == 0:
            rfile.readline()  # consume trailing \r\n after last chunk
            break
        body.write(rfile.read(chunk_size))
        rfile.readline()  # consume \r\n after chunk data
    return body.getvalue()


def _make_http_handler(
    logs_collector: MockCollectorLogsService,
    metrics_collector: MockCollectorMetricsService,
):
    """Create an HTTP request handler that routes OTLP HTTP logs and metrics
    into the same queues used by the gRPC services.

    Uses HTTP/1.1 with keep-alive and supports both Content-Length and
    Transfer-Encoding: chunked request bodies (Node.js defaults to
    chunked when Content-Length is not explicitly set).

    Supports both JSON (default for @opentelemetry/exporter-*-otlp-http)
    and protobuf content types."""

    class OtlpHttpHandler(BaseHTTPRequestHandler):
        # HTTP/1.1 is required so Node.js clients can reuse connections
        # and the BatchLogRecordProcessor's export promises resolve properly.
        protocol_version = "HTTP/1.1"

        def _read_body(self):
            """Read the full request body, supporting both Content-Length
            and Transfer-Encoding: chunked."""
            te = self.headers.get("Transfer-Encoding", "")
            if "chunked" in te.lower():
                return _read_chunked(self.rfile)
            content_length = self.headers.get("Content-Length")
            if content_length is not None and content_length != "":
                return self.rfile.read(int(content_length))
            return b""

        def _parse_and_store(self, request_cls, response_cls, queue):
            body = self._read_body()
            content_type = self.headers.get("Content-Type", "")
            # ServiceEvents's profile pipeline ships OTLP payloads uncompressed by
            # default since the profile body is already zstd+base64-compressed at the
            # app layer. Decode is header-driven, so if the compression is switched to
            # gzip we still honor the Content-Encoding header and parse the compressed body.
            content_encoding = self.headers.get("Content-Encoding", "").lower()
            if content_encoding == "gzip" and len(body) > 0:
                body = gzip.decompress(body)
            try:
                req = request_cls()
                if len(body) > 0:
                    if "application/json" in content_type:
                        proto_json_parse(body.decode("utf-8"), req)
                    else:
                        req.ParseFromString(body)
                    queue.put(req)
                if "application/json" in content_type:
                    resp_bytes = b"{}"
                    resp_ct = "application/json"
                else:
                    resp_bytes = response_cls().SerializeToString()
                    resp_ct = "application/x-protobuf"
                self.send_response(200)
                self.send_header("Content-Type", resp_ct)
                self.send_header("Content-Length", str(len(resp_bytes)))
                self.end_headers()
                self.wfile.write(resp_bytes)
            except Exception as e:
                print(f"HTTP {self.path} ERROR: {e}", flush=True, file=sys.stderr)
                self.send_response(400)
                self.send_header("Content-Length", "0")
                self.end_headers()

        def do_POST(self):
            if self.path == "/v1/logs":
                self._parse_and_store(
                    ExportLogsServiceRequest,
                    ExportLogsServiceResponse,
                    logs_collector._export_requests,
                )
            elif self.path == "/v1/metrics":
                self._parse_and_store(
                    ExportMetricsServiceRequest,
                    ExportMetricsServiceResponse,
                    metrics_collector._export_requests,
                )
            else:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

        def log_message(self, format, *args):
            # Suppress per-request logs to keep output clean
            pass

    return OtlpHttpHandler


class _ThreadingHTTPServer(ThreadingTCPServer):
    """A threading HTTP server that allows address reuse."""
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    mock_collector_server: server = server(thread_pool=ThreadPoolExecutor(max_workers=10))
    mock_collector_server.add_insecure_port(f"0.0.0.0:{_GRPC_PORT}")

    trace_collector: MockCollectorTraceService = MockCollectorTraceService()
    metrics_collector: MockCollectorMetricsService = MockCollectorMetricsService()
    logs_collector: MockCollectorLogsService = MockCollectorLogsService()
    mock_collector: MockCollectorService = MockCollectorService(trace_collector, metrics_collector, logs_collector)

    add_TraceServiceServicer_to_server(trace_collector, mock_collector_server)
    add_MetricsServiceServicer_to_server(metrics_collector, mock_collector_server)
    add_LogsServiceServicer_to_server(logs_collector, mock_collector_server)
    add_MockCollectorServiceServicer_to_server(mock_collector, mock_collector_server)

    mock_collector_server.start()
    atexit.register(mock_collector_server.stop, None)

    # Start OTLP/HTTP receiver on a separate port for clients using
    # @opentelemetry/exporter-{logs,metrics}-otlp-http (DI snapshot emitter +
    # ServiceEvents). Routes /v1/logs and /v1/metrics into the same queues used
    # by their gRPC counterparts.
    http_server = _ThreadingHTTPServer(
        ("0.0.0.0", _HTTP_PORT),
        _make_http_handler(logs_collector, metrics_collector),
    )
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()

    print("Ready")
    mock_collector_server.wait_for_termination(None)


if __name__ == "__main__":
    main()
