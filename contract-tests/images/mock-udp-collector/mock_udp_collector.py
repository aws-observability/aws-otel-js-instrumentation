# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Mock UDP collector that mimics the X-Ray daemon's UDP interface.

Receives OTLP-encoded trace data over UDP (same protocol as the lite SDK sends),
parses it, and exposes an HTTP query API for test assertions.
"""
import base64
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

_UDP_PORT = 2000
_HTTP_PORT = 8080
_PROTOCOL_HEADER = '{"format":"json","version":1}\n'

collected_spans = []
collected_raw = []
lock = threading.Lock()


class QueryHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/spans":
            with lock:
                body = json.dumps(collected_spans)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body.encode())
        elif self.path == "/raw":
            with lock:
                body = json.dumps(collected_raw)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body.encode())
        elif self.path == "/count":
            with lock:
                count = len(collected_spans)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"count": count}).encode())
        elif self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def do_DELETE(self):
        if self.path == "/spans":
            with lock:
                collected_spans.clear()
                collected_raw.clear()
            self.send_response(200)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


def _parse_udp_message(data: bytes):
    """Parse the lite SDK's UDP message format: header + prefix + base64(otlp)."""
    text = data.decode("utf-8")
    if not text.startswith(_PROTOCOL_HEADER):
        return None, None
    payload = text[len(_PROTOCOL_HEADER):]
    prefix = payload[:3]
    otlp_b64 = payload[3:]
    otlp_bytes = base64.b64decode(otlp_b64)
    return prefix, otlp_bytes


def _udp_listener():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", _UDP_PORT))
    print(f"UDP listener ready on port {_UDP_PORT}", flush=True)
    while True:
        data, addr = sock.recvfrom(65535)
        try:
            prefix, otlp_bytes = _parse_udp_message(data)
            if otlp_bytes is None:
                continue
            req = ExportTraceServiceRequest()
            req.ParseFromString(otlp_bytes)
            with lock:
                collected_raw.append({
                    "prefix": prefix,
                    "size": len(otlp_bytes),
                    "from": str(addr),
                })
                for rs in req.resource_spans:
                    resource_attrs = {
                        kv.key: kv.value.string_value or str(kv.value.int_value)
                        for kv in rs.resource.attributes
                    }
                    for ss in rs.scope_spans:
                        scope_name = ss.scope.name if ss.scope else ""
                        scope_version = ss.scope.version if ss.scope else ""
                        for span in ss.spans:
                            span_data = {
                                "name": span.name,
                                "trace_id": span.trace_id.hex(),
                                "span_id": span.span_id.hex(),
                                "parent_span_id": span.parent_span_id.hex() if span.parent_span_id else "",
                                "kind": span.kind,
                                "status_code": span.status.code,
                                "status_message": span.status.message,
                                "flags": span.flags,
                                "start_time": span.start_time_unix_nano,
                                "end_time": span.end_time_unix_nano,
                                "attributes": {
                                    kv.key: kv.value.string_value or str(kv.value.int_value)
                                    for kv in span.attributes
                                },
                                "events": [
                                    {"name": e.name, "timestamp": e.time_unix_nano}
                                    for e in span.events
                                ],
                                "resource": resource_attrs,
                                "scope_name": scope_name,
                                "scope_version": scope_version,
                                "prefix": prefix,
                            }
                            collected_spans.append(span_data)
        except Exception as e:
            print(f"Error parsing UDP message: {e}", flush=True)


if __name__ == "__main__":
    udp_thread = threading.Thread(target=_udp_listener, daemon=True)
    udp_thread.start()

    print(f"HTTP query server ready on port {_HTTP_PORT}", flush=True)
    print("Ready", flush=True)
    server = HTTPServer(("0.0.0.0", _HTTP_PORT), QueryHandler)
    server.serve_forever()
