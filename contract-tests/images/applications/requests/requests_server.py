# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
import atexit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from requests import Response, request
from typing_extensions import Tuple, override

_PORT: int = 8080
_NETWORK_ALIAS: str = "backend"
_SUCCESS: str = "success"
_ERROR: str = "error"
_FAULT: str = "fault"


class RequestHandler(BaseHTTPRequestHandler):
    @override
    # pylint: disable=invalid-name
    def do_GET(self):
        self.handle_request("GET")

    @override
    # pylint: disable=invalid-name
    def do_POST(self):
        self.handle_request("POST")

    def handle_request(self, method: str):
        status_code: int
        if self.in_path(_NETWORK_ALIAS):
            if self.in_path(_SUCCESS):
                status_code = 200
            elif self.in_path(_ERROR):
                status_code = 400
            elif self.in_path(_FAULT):
                status_code = 500
            else:
                status_code = 404
        else:
            url: str = f"http://{_NETWORK_ALIAS}:{_PORT}/{_NETWORK_ALIAS}{self.path}"
            response: Response = request(method, url, timeout=20)
            status_code = response.status_code
        self.send_response_only(status_code)
        self.end_headers()

    def in_path(self, sub_path: str):
        return sub_path in self.path


def main() -> None:
    server_address: Tuple[str, int] = ("0.0.0.0", _PORT)
    request_handler_class: type = RequestHandler
    requests_server: ThreadingHTTPServer = ThreadingHTTPServer(server_address, request_handler_class)
    atexit.register(requests_server.shutdown)
    server_thread: Thread = Thread(target=requests_server.serve_forever)
    server_thread.start()
    print("Ready")
    server_thread.join()


if __name__ == "__main__":
    main()
