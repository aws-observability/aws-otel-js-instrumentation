# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""DI (Dynamic Instrumentation) contract-test base using OTLP LogRecord verification.

Snapshots are emitted as OTLP LogRecords to the mock collector via HTTP, and tests
query the collector via MockCollectorClient (gRPC).

The mock collector exposes:
  - gRPC on port 4315 (used by the test client to read back captured telemetry)
  - HTTP on port 4318 (used by the DI snapshot OTLP HTTP exporter)

Snapshot pipeline:
  App function hit -> SnapshotOtlpEmitter -> POST /v1/logs (HTTP) -> mock collector
  Tests -> MockCollectorClient.get_logs_now() (gRPC) -> filter by event.name
"""
import time
from logging import INFO, Logger, getLogger
from typing import Any, Dict, List, Optional, Set
from unittest import TestCase

from docker import DockerClient
from docker.models.networks import Network, NetworkCollection
from docker.types import EndpointConfig
from mock_collector_client import MockCollectorClient, ResourceScopeLog
from requests import Response, request
from testcontainers.core.container import DockerContainer
from testcontainers.core.waiting_utils import wait_for_logs
from typing_extensions import override

_logger: Logger = getLogger(__name__)
_logger.setLevel(INFO)

NETWORK_NAME: str = "aws-application-signals-network"
_MOCK_COLLECTOR_ALIAS: str = "collector"
_MOCK_COLLECTOR_NAME: str = "aws-application-signals-mock-collector-nodejs"
_MOCK_COLLECTOR_GRPC_PORT: int = 4315
_MOCK_COLLECTOR_HTTP_PORT: int = 4318

DI_EVENT_NAME: str = "aws.dynamic_instrumentation.snapshot"
DI_POLL_INTERVAL: str = "10"
DI_WAIT_TIMEOUT: float = 45.0
DI_POLL_SLEEP: float = 1.0


# ---------------------------------------------------------------------------
# Protobuf conversion helpers — flatten OTLP AnyValue into native Python types
# ---------------------------------------------------------------------------

def _any_value_to_py(v) -> Any:
    if v is None:
        return None
    field = v.WhichOneof("value")
    if field is None:
        return None
    if field == "string_value":
        return v.string_value
    if field == "int_value":
        return v.int_value
    if field == "double_value":
        return v.double_value
    if field == "bool_value":
        return v.bool_value
    if field == "bytes_value":
        try:
            return v.bytes_value.decode("utf-8")
        except Exception:
            return v.bytes_value
    if field == "kvlist_value":
        return {kv.key: _any_value_to_py(kv.value) for kv in v.kvlist_value.values}
    if field == "array_value":
        return [_any_value_to_py(e) for e in v.array_value.values]
    return None


def _attrs_to_dict(kvs) -> Dict[str, Any]:
    return {kv.key: _any_value_to_py(kv.value) for kv in kvs}


# ---------------------------------------------------------------------------
# Test infrastructure
# ---------------------------------------------------------------------------

class DITestInfrastructure(TestCase):
    """Shared boilerplate for DI contract tests.

    Sets up mock-collector (gRPC + HTTP) on a Docker network, then an Express
    app container with DI enabled pointing snapshots at the HTTP receiver.
    """

    application: DockerContainer
    mock_collector: DockerContainer
    mock_collector_client: MockCollectorClient
    network: Network

    @classmethod
    @override
    def setUpClass(cls) -> None:
        cls.addClassCleanup(cls.class_tear_down)
        cls.network = NetworkCollection(client=DockerClient()).create(NETWORK_NAME)
        mock_collector_networking_config: Dict[str, EndpointConfig] = {
            NETWORK_NAME: EndpointConfig(version="1.22", aliases=[_MOCK_COLLECTOR_ALIAS])
        }
        cls.mock_collector = (
            DockerContainer(_MOCK_COLLECTOR_NAME)
            .with_exposed_ports(_MOCK_COLLECTOR_GRPC_PORT, _MOCK_COLLECTOR_HTTP_PORT)
            .with_name(_MOCK_COLLECTOR_NAME)
            .with_kwargs(network=NETWORK_NAME, networking_config=mock_collector_networking_config)
        )
        cls.mock_collector.start()
        wait_for_logs(cls.mock_collector, "Ready", timeout=20)

    @classmethod
    def class_tear_down(cls) -> None:
        try:
            _logger.info("MockCollector stdout:\n%s", cls.mock_collector.get_logs()[0].decode())
            _logger.info("MockCollector stderr:\n%s", cls.mock_collector.get_logs()[1].decode())
            cls.mock_collector.stop()
        except Exception:
            _logger.exception("Failed to tear down mock collector")
        try:
            cls.network.remove()
        except Exception:
            pass

    @override
    def setUp(self) -> None:
        self.addCleanup(self.tear_down)
        app_networking_config: Dict[str, EndpointConfig] = {
            NETWORK_NAME: EndpointConfig(version="1.22", aliases=[self.get_application_image_name()])
        }

        # DI snapshots are sent via OTLP/HTTP to the mock collector's HTTP port
        di_logs_endpoint = f"http://{_MOCK_COLLECTOR_ALIAS}:{_MOCK_COLLECTOR_HTTP_PORT}/v1/logs"

        self.application = (
            DockerContainer(self.get_application_image_name())
            .with_exposed_ports(self.get_application_port())
            # Standard OTel config
            # NOTE: JS SDK skips initialization entirely when OTEL_TRACES_EXPORTER=none,
            # which prevents DI from starting. Use "console" to keep SDK alive.
            .with_env("OTEL_TRACES_EXPORTER", "console")
            .with_env("OTEL_METRICS_EXPORTER", "none")
            .with_env("OTEL_LOGS_EXPORTER", "none")
            .with_env("OTEL_AWS_APPLICATION_SIGNALS_ENABLED", "false")
            .with_env("OTEL_TRACES_SAMPLER", "always_on")
            .with_env("OTEL_SERVICE_NAME", self.get_application_otel_service_name())
            .with_env("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=test")
            # DI config
            .with_env("OTEL_AWS_DYNAMIC_INSTRUMENTATION_ENABLED", "true")
            .with_env("OTEL_AWS_DYNAMIC_INSTRUMENTATION_API_URL", "http://localhost:3030")
            .with_env("OTEL_AWS_OTLP_LOGS_ENDPOINT", di_logs_endpoint)
            .with_env("OTEL_AWS_DYNAMIC_INSTRUMENTATION_OUTPUT_DIRECTORY", "/tmp/aws-di-snapshots")
            .with_env("OTEL_AWS_DYNAMIC_INSTRUMENTATION_BREAKPOINT_POLL_INTERVAL", DI_POLL_INTERVAL)
            .with_env("OTEL_AWS_DYNAMIC_INSTRUMENTATION_PROBE_POLL_INTERVAL", DI_POLL_INTERVAL)
            .with_env("OTEL_LOG_LEVEL", "debug")
            .with_kwargs(network=NETWORK_NAME, networking_config=app_networking_config)
            .with_name(self.get_application_image_name())
        )

        for key, val in self.get_application_extra_environment_variables().items():
            self.application.with_env(key, val)

        self.application.start()
        wait_for_logs(
            self.application,
            self.get_application_wait_pattern(),
            timeout=self.get_application_start_timeout(),
        )
        self.mock_collector_client = MockCollectorClient(
            self.mock_collector.get_container_host_ip(),
            self.mock_collector.get_exposed_port(_MOCK_COLLECTOR_GRPC_PORT),
        )
        # Wait for DI pollers to fetch configs and instrument functions
        time.sleep(int(DI_POLL_INTERVAL) + 10)
        # Clear startup signals so each test sees only its own telemetry
        self.mock_collector_client.clear_signals()

    def tear_down(self) -> None:
        try:
            _logger.info("Application stdout:\n%s", self.application.get_logs()[0].decode())
            _logger.info("Application stderr:\n%s", self.application.get_logs()[1].decode())
            self.application.stop()
        except Exception:
            _logger.exception("Failed to tear down application")

    # -------------------------------------------------------------------------
    # Snapshot retrieval via OTLP
    # -------------------------------------------------------------------------

    def _get_di_snapshots(self) -> List[ResourceScopeLog]:
        records = self.mock_collector_client.get_logs_now()
        out = []
        for rec in records:
            attrs = _attrs_to_dict(rec.log_record.attributes)
            if attrs.get("event.name") == DI_EVENT_NAME:
                out.append(rec)
        return out

    def wait_for_snapshots(
        self,
        min_count: int = 1,
        timeout: Optional[float] = None,
    ) -> List[ResourceScopeLog]:
        deadline = time.time() + (timeout if timeout is not None else DI_WAIT_TIMEOUT)
        matched: List[ResourceScopeLog] = []
        while time.time() < deadline:
            matched = self._get_di_snapshots()
            if len(matched) >= min_count:
                return matched
            time.sleep(DI_POLL_SLEEP)
        if len(matched) < min_count:
            all_events: Set[str] = set()
            for rec in self.mock_collector_client.get_logs_now():
                attrs = _attrs_to_dict(rec.log_record.attributes)
                name = attrs.get("event.name")
                if name:
                    all_events.add(name)
            self.fail(
                f"Timed out waiting for {min_count} DI snapshot(s). "
                f"Found {len(matched)}. All event.names seen: {sorted(all_events)}."
            )
        return matched

    # -------------------------------------------------------------------------
    # Attribute and body helpers
    # -------------------------------------------------------------------------

    @staticmethod
    def log_attrs(record: ResourceScopeLog) -> Dict[str, Any]:
        return _attrs_to_dict(record.log_record.attributes)

    @staticmethod
    def log_body(record: ResourceScopeLog) -> Any:
        return _any_value_to_py(record.log_record.body)

    def get_attr(self, record: ResourceScopeLog, key: str) -> Any:
        return self.log_attrs(record).get(key)

    def _line_locals(self, record: ResourceScopeLog) -> Dict[str, Any]:
        """Return the locals dict of the first (only) line capture in a snapshot body.

        JS DI is line-level only, so every snapshot body has captures.lines with a
        single line entry. Fails the test if the structure is missing.
        """
        body = self.log_body(record)
        self.assertIsInstance(body, dict, "Snapshot body should be a dict")
        captures = body.get("captures", {})
        lines = captures.get("lines", {})
        self.assertGreater(len(lines), 0, f"Expected at least one line capture, got captures: {list(captures.keys())}")
        return list(lines.values())[0].get("locals", {})

    # -------------------------------------------------------------------------
    # Filtering helpers
    # -------------------------------------------------------------------------

    def snapshots_for_method(self, snapshots: List[ResourceScopeLog], method_name: str) -> List[ResourceScopeLog]:
        return [s for s in snapshots if self.get_attr(s, "aws.di.method_name") == method_name]

    def snapshots_for_location_hash(self, snapshots: List[ResourceScopeLog], location_hash: str) -> List[ResourceScopeLog]:
        return [s for s in snapshots if self.get_attr(s, "aws.di.location_hash") == location_hash]

    # -------------------------------------------------------------------------
    # Request helper
    # -------------------------------------------------------------------------

    def send_request(self, method: str, path: str, **kwargs) -> Response:
        address: str = self.application.get_container_host_ip()
        port: str = self.application.get_exposed_port(self.get_application_port())
        url: str = f"http://{address}:{port}/{path}"
        return request(method, url, timeout=20, **kwargs)

    # -------------------------------------------------------------------------
    # Overridable methods
    # -------------------------------------------------------------------------

    @staticmethod
    def get_application_image_name() -> str:
        raise NotImplementedError("Subclasses must implement get_application_image_name")

    def get_application_port(self) -> int:
        return 8080

    def get_application_extra_environment_variables(self) -> Dict[str, str]:
        return {}

    def get_application_wait_pattern(self) -> str:
        return "Ready"

    def get_application_otel_service_name(self) -> str:
        return "di-test-service"

    def get_application_start_timeout(self) -> int:
        return 30
