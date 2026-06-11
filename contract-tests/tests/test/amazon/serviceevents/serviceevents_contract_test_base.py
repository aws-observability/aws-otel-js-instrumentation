# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""ServiceEvents contract-test base (OTLP-native).

Uses the mock collector's `get_logs` rpc (spec: mock_collector_service.proto).
Each ServiceEvents signal is one LogRecord whose `event.name` attribute selects
the signal type.

Signals emitted by ServiceEvents:
  - aws.service_events.endpoint_summary    (LogRecord)
  - aws.service_events.function_call       (LogRecord; SEH/EMF fallback only — emitted when the
    `service.function.duration` histogram is NOT wired, e.g. in
    `OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE` mode. Skipped when histogram is wired.)
  - service.function.duration              (OTel Exponential Histogram; primary FunctionCall
    signal when an OTLP network endpoint is configured)
  - aws.service_events.incident_snapshot   (LogRecord; sets trace_id/span_id)
  - aws.service_events.deployment_event    (LogRecord; body empty)
  - EndpointErrorMetric              (OTel Sum metric, name="count")
"""
import time
from logging import INFO, Logger, getLogger
from typing import Any, Dict, List, Optional
from unittest import TestCase

from docker import DockerClient
from docker.models.networks import Network, NetworkCollection
from docker.types import EndpointConfig
from mock_collector_client import (
    MockCollectorClient,
    ResourceScopeLog,
    ResourceScopeMetric,
)
from requests import Response, request
from testcontainers.core.container import DockerContainer
from testcontainers.core.waiting_utils import wait_for_logs
from typing_extensions import override

_logger: Logger = getLogger(__name__)
_logger.setLevel(INFO)

NETWORK_NAME: str = "aws-application-signals-network"
_MOCK_COLLECTOR_ALIAS: str = "collector"
_MOCK_COLLECTOR_NAME: str = "aws-application-signals-mock-collector-nodejs"
# gRPC port — still used by MockCollectorClient for signal retrieval.
_MOCK_COLLECTOR_PORT: int = 4315
# HTTP port — used by the ServiceEvents SDK to send OTLP logs/metrics.
_MOCK_COLLECTOR_HTTP_PORT: int = 4318

SERVICE_EVENTS_FLUSH_INTERVAL_MS: str = "2000"
SERVICE_EVENTS_WAIT_TIMEOUT: float = 25.0
SERVICE_EVENTS_POLL_INTERVAL: float = 0.5

VALID_SEVERITIES = {"critical", "high", "medium", "low", "info"}


# ---------------------------------------------------------------------------
# Protobuf conversion helpers
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


# pylint: disable=broad-exception-caught
class ServiceEventsTestInfrastructure(TestCase):
    """Shared boilerplate: mock-collector container on a docker network, app container
    wired to the collector via OTLP. Subclasses implement get_application_image_name."""

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
            .with_exposed_ports(_MOCK_COLLECTOR_PORT, _MOCK_COLLECTOR_HTTP_PORT)
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
        self.application = (
            DockerContainer(self.get_application_image_name())
            .with_exposed_ports(self.get_application_port())
            # Standard OTel config. OTEL_METRICS_EXPORTER=none prevents the
            # default metrics pipeline from polluting the collector with
            # runtime-node metrics (matches the e2e_otlp_cloudwatch_test.py
            # pattern).
            .with_env("OTEL_TRACES_EXPORTER", "none")
            .with_env("OTEL_METRICS_EXPORTER", "none")
            .with_env("OTEL_LOGS_EXPORTER", "none")
            .with_env("OTEL_AWS_APPLICATION_SIGNALS_ENABLED", "false")
            .with_env("OTEL_SERVICE_NAME", self.get_application_otel_service_name())
            .with_env("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=test")
            # ServiceEvents-specific OTLP endpoints. ServiceEvents is HTTP-only; routes
            # land in the mock collector's shared logs/metrics queues via the
            # /v1/logs and /v1/metrics HTTP handlers.
            .with_env("OTEL_AWS_SERVICE_EVENTS_ENABLED", "true")
            .with_env(
                "OTEL_AWS_OTLP_LOGS_ENDPOINT",
                f"http://{_MOCK_COLLECTOR_ALIAS}:{_MOCK_COLLECTOR_HTTP_PORT}/v1/logs",
            )
            .with_env(
                "OTEL_AWS_OTLP_METRICS_ENDPOINT",
                f"http://{_MOCK_COLLECTOR_ALIAS}:{_MOCK_COLLECTOR_HTTP_PORT}/v1/metrics",
            )
            .with_env("OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED", "true")
            # Flush intervals are internal now (no public env var); inject the fast test
            # cadence through the gated test-config hook. See get_test_config_hook_overrides().
            .with_env("DEBUG_SE_TEST_CONFIG", self._build_test_config_hook_value())
            # Force the OTel metric reader to flush every 2s so contract tests
            # see service.function.duration data points within the wait window.
            # Production defaults to 60s.
            .with_env("OTEL_METRIC_EXPORT_INTERVAL", SERVICE_EVENTS_FLUSH_INTERVAL_MS)
            .with_env("OTEL_AWS_SERVICE_EVENTS_SAMPLING_MODE", "always")
            # Explicit allowlist required — there is no implicit default scope. The express /
            # fastify contract-test apps live under /serviceevents-express/ and
            # /serviceevents-fastify/ (app.js + helpers.js). A bare '*'/'**' would be normalized
            # away as invalid input, so we use a path-bounded glob.
            .with_env("OTEL_AWS_SERVICE_EVENTS_PACKAGES_INCLUDE", "**/serviceevents-express/**,**/serviceevents-fastify/**")
            .with_env("OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_PER_MINUTE", "1000")
            .with_env("OTEL_AWS_SERVICE_EVENTS_INCIDENT_SNAPSHOT_MAX_SAME_ERROR", "100")
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
            self.mock_collector.get_exposed_port(_MOCK_COLLECTOR_PORT),
        )
        # Clear startup signals so each test sees only the telemetry its requests
        # generate. Matches the pattern used by aws-sdk_test.py etc.
        time.sleep(2)
        self.mock_collector_client.clear_signals()

    def tear_down(self) -> None:
        try:
            _logger.info("Application stdout:\n%s", self.application.get_logs()[0].decode())
            _logger.info("Application stderr:\n%s", self.application.get_logs()[1].decode())
            self.application.stop()
        except Exception:
            _logger.exception("Failed to tear down application")

    # -------------------------------------------------------------------------
    # Record reading (non-blocking snapshots + polling helpers)
    # -------------------------------------------------------------------------

    def _get_log_records_matching(self, event_name: str) -> List[ResourceScopeLog]:
        records = self.mock_collector_client.get_logs_now()
        out = []
        for rec in records:
            attrs = _attrs_to_dict(rec.log_record.attributes)
            if attrs.get("event.name") == event_name:
                out.append(rec)
        return out

    def wait_for_log_records(
        self,
        event_name: str,
        min_count: int = 1,
        timeout: Optional[float] = None,
    ) -> List[ResourceScopeLog]:
        deadline = time.time() + (timeout if timeout is not None else SERVICE_EVENTS_WAIT_TIMEOUT)
        matched: List[ResourceScopeLog] = []
        while time.time() < deadline:
            matched = self._get_log_records_matching(event_name)
            if len(matched) >= min_count:
                return matched
            time.sleep(SERVICE_EVENTS_POLL_INTERVAL)
        if len(matched) < min_count:
            all_events = set()
            for rec in self.mock_collector_client.get_logs_now():
                attrs = _attrs_to_dict(rec.log_record.attributes)
                name = attrs.get("event.name")
                if name:
                    all_events.add(name)
            self.fail(
                f"Timed out waiting for {min_count} '{event_name}' LogRecord(s). "
                f"Found {len(matched)}. Signals seen: {sorted(all_events)}."
            )
        return matched

    def wait_for_metric(self, metric_name: str, timeout: Optional[float] = None) -> List[ResourceScopeMetric]:
        """Poll the mock collector for an OTel metric with the given name."""
        deadline = time.time() + (timeout if timeout is not None else SERVICE_EVENTS_WAIT_TIMEOUT)
        while time.time() < deadline:
            try:
                results = self.mock_collector_client.get_metrics({metric_name})
                if results:
                    return [r for r in results if r.metric.name == metric_name]
            except RuntimeError:
                pass
            time.sleep(SERVICE_EVENTS_POLL_INTERVAL)
        self.fail(f"Timed out waiting for metric '{metric_name}'")
        return []

    # -------------------------------------------------------------------------
    # OTLP metric helpers — function-call latency Histogram
    # -------------------------------------------------------------------------
    #
    # FunctionCall telemetry now flows through a single OTel metric:
    #
    #   - service.function.duration (Histogram): sampled calls only — latency

    _FUNCTION_DURATION_METRIC_NAME: str = "service.function.duration"

    def _peek_function_duration_data_points(self) -> List:
        """Return all data points for the service.function.duration histogram (non-blocking)."""
        if self.mock_collector_client is None:
            return []
        try:
            metrics = self.mock_collector_client.get_metrics({self._FUNCTION_DURATION_METRIC_NAME})
        except RuntimeError:
            return []
        data_points: List = []
        for rsm in metrics:
            if rsm.metric.name != self._FUNCTION_DURATION_METRIC_NAME:
                continue
            histogram_proto = rsm.metric.WhichOneof("data")
            if histogram_proto == "exponential_histogram":
                data_points.extend(rsm.metric.exponential_histogram.data_points)
            elif histogram_proto == "histogram":
                data_points.extend(rsm.metric.histogram.data_points)
        return data_points

    def wait_for_function_duration_metric(self, min_count: int = 1, timeout: Optional[float] = None) -> List:
        """Poll until at least min_count data points appear in the function-duration histogram."""
        if self.mock_collector_client is None:
            self.fail("Mock collector not initialized — cannot poll OTLP metrics")
        deadline = time.time() + (timeout if timeout is not None else SERVICE_EVENTS_WAIT_TIMEOUT)
        data_points: List = []
        while time.time() < deadline:
            data_points = self._peek_function_duration_data_points()
            if len(data_points) >= min_count:
                return data_points
            time.sleep(SERVICE_EVENTS_POLL_INTERVAL)
        self.fail(
            f"Timed out waiting for {min_count} '{self._FUNCTION_DURATION_METRIC_NAME}' "
            f"histogram data point(s). Found {len(data_points)} after {timeout}s."
        )
        return data_points

    @classmethod
    def dp_attrs(cls, data_point) -> Dict[str, Any]:
        """Return a histogram data point's attributes as a flat {key: python_value} dict."""
        return _attrs_to_dict(data_point.attributes)

    def assert_function_duration_data_point(self, data_point, **kwargs) -> None:
        """Assert a `service.function.duration` data point has the expected attribute structure.

        Note: ``exception.type`` is intentionally NOT a histogram dimension —
        the only error signal on this metric is ``status="error"``. Exception
        class names live on the IncidentSnapshot log signal so cardinality stays
        bounded. Use ``status`` here, and assert the class on incident snapshot
        logs (see ``assert_incident_snapshot``).
        """
        attrs = self.dp_attrs(data_point)
        self.assertIn("function.name", attrs)
        self.assertGreater(data_point.count, 0, "Expected histogram data point count > 0")

        if "function_name" in kwargs:
            self.assertEqual(attrs["function.name"], kwargs["function_name"])
        if "status" in kwargs:
            self.assertEqual(attrs.get("status"), kwargs["status"])
        if "has_caller" in kwargs and kwargs["has_caller"]:
            self.assertIn("aws.service_events.caller", attrs)

    # -------------------------------------------------------------------------
    # Request helper
    # -------------------------------------------------------------------------

    def send_request(self, method: str, path: str, **kwargs) -> Response:
        address: str = self.application.get_container_host_ip()
        port: str = self.application.get_exposed_port(self.get_application_port())
        url: str = f"http://{address}:{port}/{path}"
        return request(method, url, timeout=20, **kwargs)

    # -------------------------------------------------------------------------
    # Spec-aligned assertion helpers
    # -------------------------------------------------------------------------

    @staticmethod
    def log_attrs(record: ResourceScopeLog) -> Dict[str, Any]:
        return _attrs_to_dict(record.log_record.attributes)

    @staticmethod
    def log_body(record: ResourceScopeLog) -> Any:
        return _any_value_to_py(record.log_record.body)

    @staticmethod
    def scope_name(record: ResourceScopeLog) -> str:
        return record.scope_logs.scope.name

    @staticmethod
    def scope_version(record: ResourceScopeLog) -> str:
        return record.scope_logs.scope.version

    def assert_endpoint_summary(self, record: ResourceScopeLog, **kwargs) -> None:
        attrs = self.log_attrs(record)
        self.assertEqual(attrs.get("event.name"), "aws.service_events.endpoint_summary")
        self.assertEqual(self.scope_name(record), "serviceevents")
        self.assertEqual(self.scope_version(record), "1.0")
        for key in (
            "http.request.method",
            "url.route",
            "aws.service_events.operation",
            "aws.service_events.request.count",
            "aws.service_events.request.faults",
            "aws.service_events.request.errors",
            "aws.service_events.incident.count",
        ):
            self.assertIn(key, attrs, f"Missing attr {key}")
        body = self.log_body(record)
        self.assertIsInstance(body, dict)
        self.assertIn("duration", body)
        self.assertIn("exception_breakdown", body)
        self.assertIn("incidents_exemplar", body)
        if "method" in kwargs:
            self.assertEqual(attrs.get("http.request.method"), kwargs["method"])
        if "route" in kwargs:
            self.assertEqual(attrs.get("url.route"), kwargs["route"])

    def assert_function_call(self, record: ResourceScopeLog, **kwargs) -> None:
        """Asserts the legacy `aws.service_events.function_call` LogRecord shape.

        Coexists with the OTel `service.function.duration` histogram metric:
        the LogRecord carries full-fidelity counts (every invocation), the
        histogram carries sampled latencies. Use
        `assert_function_duration_data_point()` for the latter."""
        attrs = self.log_attrs(record)
        self.assertEqual(attrs.get("event.name"), "aws.service_events.function_call")
        self.assertIn("aws.service_events.function_name", attrs)
        self.assertIn("aws.service_events.version", attrs)

    def assert_incident_snapshot(self, record: ResourceScopeLog, **kwargs) -> None:
        attrs = self.log_attrs(record)
        self.assertEqual(attrs.get("event.name"), "aws.service_events.incident_snapshot")
        for key in (
            "aws.service_events.snapshot_id",
            "aws.service_events.trigger_type",
            "aws.service_events.operation",
            "aws.service_events.duration_ms",
            "aws.service_events.is_partial",
            "http.request.method",
            "url.route",
            "http.response.status_code",
            "aws.service_events.request.type",
        ):
            self.assertIn(key, attrs, f"Missing attr {key}")
        body = self.log_body(record)
        self.assertIsInstance(body, dict)
        self.assertIn("exception_info", body)
        self.assertIn("request_context", body)
        if "trigger_type" in kwargs:
            self.assertEqual(attrs.get("aws.service_events.trigger_type"), kwargs["trigger_type"])

    def assert_deployment_event(self, record: ResourceScopeLog) -> None:
        attrs = self.log_attrs(record)
        self.assertEqual(attrs.get("event.name"), "aws.service_events.deployment_event")
        body = self.log_body(record)
        # spec §6: body is empty (protobuf: unset AnyValue → None)
        self.assertTrue(body is None or body == "" or body == {})

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

    def get_test_config_hook_overrides(self) -> Dict[str, str]:
        """Internal test-config hook overrides (KEY -> value) injected via DEBUG_SE_TEST_CONFIG.

        These knobs are internal (no public env var); black-box tests set them through the hook.
        The base wires the fast flush cadence; subclasses extend (don't replace) for extra knobs
        like the SAMPLE_TIER* tiers.
        """
        return {
            "FUNCTION_CALL_FLUSH_INTERVAL": SERVICE_EVENTS_FLUSH_INTERVAL_MS,
            "ENDPOINT_FLUSH_INTERVAL": SERVICE_EVENTS_FLUSH_INTERVAL_MS,
            "INCIDENT_SNAPSHOT_FLUSH_INTERVAL": SERVICE_EVENTS_FLUSH_INTERVAL_MS,
        }

    def _build_test_config_hook_value(self) -> str:
        """Serialize get_test_config_hook_overrides() into the delimited hook format."""
        return ";".join(f"{key}={value}" for key, value in self.get_test_config_hook_overrides().items())

    def get_application_wait_pattern(self) -> str:
        return "Ready"

    def get_application_otel_service_name(self) -> str:
        return self.get_application_image_name()

    def get_application_start_timeout(self) -> int:
        return 30


class ServiceEventsContractTestBase(ServiceEventsTestInfrastructure):
    """Standard test suite — 10 tests exercising each signal type via OTLP."""

    __test__ = False

    def test_endpoint_summary_success(self) -> None:
        for _ in range(3):
            self.assertEqual(200, self.send_request("GET", "success").status_code)
        records = self.wait_for_log_records("aws.service_events.endpoint_summary")
        rec = next(
            (r for r in records if self.log_attrs(r).get("url.route") == "/success"),
            None,
        )
        self.assertIsNotNone(rec, "No EndpointSummary for /success")
        self.assert_endpoint_summary(rec, method="GET", route="/success")
        attrs = self.log_attrs(rec)
        self.assertGreaterEqual(attrs.get("aws.service_events.request.count", 0), 3)
        self.assertEqual(attrs.get("aws.service_events.request.faults", 0), 0)

    def test_endpoint_summary_fault(self) -> None:
        for _ in range(2):
            self.assertEqual(500, self.send_request("GET", "fault").status_code)
        records = self.wait_for_log_records("aws.service_events.endpoint_summary")
        rec = next(
            (r for r in records if self.log_attrs(r).get("url.route") == "/fault"),
            None,
        )
        self.assertIsNotNone(rec, "No EndpointSummary for /fault")
        self.assert_endpoint_summary(rec, method="GET", route="/fault")
        self.assertGreater(self.log_attrs(rec).get("aws.service_events.request.faults", 0), 0)

    def test_endpoint_summary_duration_body(self) -> None:
        self.send_request("GET", "success")
        rec = self.wait_for_log_records("aws.service_events.endpoint_summary")[0]
        duration = self.log_body(rec).get("duration")
        self.assertIsInstance(duration, dict)
        for key in ("Values", "Counts", "Max", "Min", "Count", "Sum"):
            self.assertIn(key, duration)
        self.assertGreater(duration.get("Count", 0), 0)
        self.assertGreater(duration.get("Sum", 0), 0)

    def test_function_call_records_exist(self) -> None:
        """FunctionCall telemetry flows through the `service.function.duration`
        histogram metric (sampled latencies) when an OTLP network endpoint is
        configured. The legacy `aws.service_events.function_call` LogRecord
        path is the SEH/EMF fallback used only when the histogram is not
        wired (e.g. `OTEL_AWS_SERVICE_EVENTS_OUTPUT_FILE` mode); when the
        histogram is wired, `__serviceeventsMonitorExit` skips
        `updateAggregations` and the `FunctionCallCollector` flushes as a
        no-op.
        """
        for _ in range(3):
            self.send_request("GET", "success")

        # The duration histogram must be populated for sampled calls.
        data_points = self.wait_for_function_duration_metric()
        self.assertGreater(len(data_points), 0)
        for dp in data_points:
            self.assert_function_duration_data_point(dp)

        # At least one data point should carry the caller attribute (nested calls).
        has_caller = any("aws.service_events.caller" in self.dp_attrs(dp) for dp in data_points)
        self.assertTrue(has_caller, "Expected at least one data point with 'aws.service_events.caller'")

    # NOTE: operation (e.g., "GET /success") is intentionally NOT a histogram
    # attribute on `service.function.duration`. Tagging by operation × function ×
    # status × exception.type would balloon attribute cardinality without bound.
    # Operation→function correlation lives on the EndpointSummary log signal
    # and on the legacy `aws.service_events.function_call` LogRecord.

    def test_incident_snapshot_on_exception(self) -> None:
        self.send_request("GET", "exception")
        records = self.wait_for_log_records("aws.service_events.incident_snapshot")
        self.assertGreater(len(records), 0)
        self.assert_incident_snapshot(records[0], trigger_type="exception")

    def test_incident_snapshot_has_call_path(self) -> None:
        self.send_request("GET", "exception")
        records = self.wait_for_log_records("aws.service_events.incident_snapshot")
        self.assertGreater(len(records), 0)
        body = self.log_body(records[0])
        exc_info = body.get("exception_info") or []
        self.assertTrue(exc_info, "exception_info should be non-empty")
        call_path = exc_info[0].get("call_path") or []
        self.assertTrue(call_path, "call_path should be non-empty")
        # Each entry uses function_name / caller_function_name (spec §5), NOT function_id
        first = call_path[0]
        self.assertIn("function_name", first)
        self.assertIn("caller_function_name", first)
        self.assertNotIn("function_id", first)
        self.assertNotIn("caller_function_id", first)

    def test_incident_snapshot_request_context_gated(self) -> None:
        """Opt-in payload gating: default (flag OFF) → no request_body etc."""
        self.send_request("GET", "exception")
        rec = self.wait_for_log_records("aws.service_events.incident_snapshot")[0]
        ctx = self.log_body(rec).get("request_context", {})
        self.assertEqual(ctx.get("type"), "http")
        self.assertIn("status_code", ctx)
        self.assertIn("timestamp", ctx)
        # With capture flag OFF (default), these fields must be absent:
        self.assertNotIn("request_body", ctx)
        self.assertNotIn("query_params", ctx)
        self.assertNotIn("path_params", ctx)
        self.assertNotIn("request_headers", ctx)

    def test_deployment_event_on_startup(self) -> None:
        # DeploymentEvent fires shortly after startup.
        records = self.wait_for_log_records("aws.service_events.deployment_event", timeout=SERVICE_EVENTS_WAIT_TIMEOUT)
        self.assertGreater(len(records), 0)
        self.assert_deployment_event(records[0])

    def test_endpoint_error_metric_emitted(self) -> None:
        """Per spec §7, EndpointErrorMetric is a Sum counter with Telemetry.Source=ServiceEvents."""
        for _ in range(2):
            self.send_request("GET", "fault")
        results = self.wait_for_metric("count")
        self.assertGreater(len(results), 0, "Should have `count` metric emitted")
        found_serviceevents = False
        for r in results:
            # Inspect Sum data points
            metric = r.metric
            if metric.HasField("sum"):
                for dp in metric.sum.data_points:
                    attrs = _attrs_to_dict(dp.attributes)
                    if attrs.get("Telemetry.Source") == "ServiceEvents":
                        found_serviceevents = True
                        for key in ("service_name", "environment", "operation", "exception"):
                            self.assertIn(key, attrs, f"Missing metric attr {key}")
        self.assertTrue(found_serviceevents, "At least one data point must have Telemetry.Source=ServiceEvents")

    def test_all_signal_types_present(self) -> None:
        self.send_request("GET", "success")
        self.send_request("GET", "exception")
        self.wait_for_log_records("aws.service_events.endpoint_summary")
        # FunctionCall telemetry flows through the duration histogram metric
        # when the histogram is wired (the legacy `aws.service_events.function_call`
        # LogRecord is the SEH/EMF fallback only).
        self.wait_for_function_duration_metric()
        self.wait_for_log_records("aws.service_events.incident_snapshot")
        self.wait_for_log_records("aws.service_events.deployment_event")

    # ---------------------------------------------------------------------
    # Gap-closure tests (from audit 2026-04-29). These run for every subclass.
    # ---------------------------------------------------------------------

    def test_incident_snapshot_error_status_trigger(self) -> None:
        """/error-status returns HTTP 500 WITHOUT throwing; incident-snapshot
        collector must pick trigger_type=exception (server error without
        a caught exception object still uses "exception" trigger).
        """
        for _ in range(3):
            self.assertEqual(500, self.send_request("GET", "error-status").status_code)
        records = self.wait_for_log_records("aws.service_events.incident_snapshot")
        rec = next(
            (r for r in records if self.log_attrs(r).get("url.route") == "/error-status"),
            None,
        )
        self.assertIsNotNone(rec, "No IncidentSnapshot for /error-status")
        attrs = self.log_attrs(rec)
        self.assertEqual(attrs.get("aws.service_events.trigger_type"), "exception")
        self.assertEqual(attrs.get("http.response.status_code"), 500)

    def test_endpoint_summary_errors_vs_faults(self) -> None:
        """EndpointSummary tracks `errors` (4xx) and `faults` (5xx) separately.

        /error returns 400 → counts as an error, not a fault.
        /fault returns 500 via throw → counts as a fault, not an error.

        EndpointSummary records are per-flush-window deltas (the collector swaps in a
        fresh aggregation map on each flush), so a burst of requests can be split across
        multiple records when it straddles a flush boundary. We therefore SUM the counts
        across every record for a route and poll until the totals reach the expected
        values — reading a single (first) record is racy under slow runners.
        """

        def _sum_for_route(route: str, field: str) -> int:
            records = self._get_log_records_matching("aws.service_events.endpoint_summary")
            total = 0
            for rec in records:
                attrs = self.log_attrs(rec)
                if attrs.get("url.route") == route:
                    total += attrs.get(field, 0)
            return total

        def _wait_for_route_total(route: str, field: str, minimum: int) -> int:
            deadline = time.time() + SERVICE_EVENTS_WAIT_TIMEOUT
            total = 0
            while time.time() < deadline:
                total = _sum_for_route(route, field)
                if total >= minimum:
                    return total
                time.sleep(SERVICE_EVENTS_POLL_INTERVAL)
            return total

        for _ in range(3):
            self.assertEqual(400, self.send_request("GET", "error").status_code)
        for _ in range(2):
            self.assertEqual(500, self.send_request("GET", "fault").status_code)

        # Poll until the cumulative (summed-across-windows) counts reach the expected totals.
        self.assertGreaterEqual(
            _wait_for_route_total("/error", "aws.service_events.request.errors", 3),
            3,
            "/error should have errors >= 3 (summed across flush windows)",
        )
        self.assertGreaterEqual(
            _wait_for_route_total("/fault", "aws.service_events.request.faults", 2),
            2,
            "/fault should have faults >= 2 (summed across flush windows)",
        )

        # Separation: /error must never record a fault, /fault must never record an error.
        self.assertEqual(
            _sum_for_route("/error", "aws.service_events.request.faults"), 0, "/error should have faults == 0"
        )
        self.assertEqual(
            _sum_for_route("/fault", "aws.service_events.request.errors"), 0, "/fault should have errors == 0"
        )

    def test_incident_snapshot_latency_trigger(self) -> None:
        """/slow busy-waits ~6s (> the 5000ms default threshold) and returns 200 with
        NO exception, so the only thing that can produce an incident snapshot is the
        latency trigger. This is the sole end-to-end exercise of trigger_type="latency"
        (the framework hook → collector duration plumbing); the collector's latency
        branch is unit-tested, but the wiring through a real request was uncovered.
        """
        self.assertEqual(200, self.send_request("GET", "slow").status_code)
        records = self.wait_for_log_records("aws.service_events.incident_snapshot")
        rec = next(
            (r for r in records if self.log_attrs(r).get("url.route") == "/slow"),
            None,
        )
        self.assertIsNotNone(rec, "No IncidentSnapshot for /slow")
        attrs = self.log_attrs(rec)
        self.assertEqual(attrs.get("aws.service_events.trigger_type"), "latency")
        self.assertEqual(attrs.get("http.response.status_code"), 200)
        # duration_ms must reflect the slow request (> the 5000ms default threshold).
        self.assertGreater(attrs.get("aws.service_events.duration_ms", 0), 5000)

    def test_incident_snapshot_post_method(self) -> None:
        """POST /data with {forceError:true} throws from the handler, producing an
        incident snapshot. Verifies the non-GET method is captured on the snapshot —
        every other incident test drives GET routes."""
        self.assertEqual(
            500,
            self.send_request("POST", "data", json={"forceError": True}).status_code,
        )
        records = self.wait_for_log_records("aws.service_events.incident_snapshot")
        rec = next(
            (r for r in records if self.log_attrs(r).get("url.route") == "/data"),
            None,
        )
        self.assertIsNotNone(rec, "No IncidentSnapshot for POST /data")
        attrs = self.log_attrs(rec)
        self.assertEqual(attrs.get("http.request.method"), "POST")
        self.assertEqual(attrs.get("aws.service_events.trigger_type"), "exception")

    def test_incident_call_path_entries_have_timing_and_line(self) -> None:
        """Spec §5 call_path entries include `duration_ns` (numeric) and
        `function_at_line` (numeric) when is_partial==false. /exception throws
        synchronously so the AST records full timing + source line."""
        self.send_request("GET", "exception")
        records = self.wait_for_log_records("aws.service_events.incident_snapshot")
        self.assertGreater(len(records), 0)
        body = self.log_body(records[0])
        # The test should only run when we have a non-partial snapshot with
        # AST-captured timing. If is_partial is true (adaptive sampling was
        # active during the call), skip — timing assertions wouldn't apply.
        if self.log_attrs(records[0]).get("aws.service_events.is_partial"):
            self.skipTest("incident captured partial — timing fields not guaranteed")
        exc_info = body.get("exception_info") or []
        self.assertTrue(exc_info, "exception_info should be non-empty")
        call_path = exc_info[0].get("call_path") or []
        self.assertTrue(call_path, "call_path should be non-empty")
        first = call_path[0]
        self.assertIn("duration_ns", first, "call_path entry should have duration_ns")
        self.assertIsInstance(first["duration_ns"], (int, float))
        self.assertGreater(first["duration_ns"], 0)
        self.assertIn("function_at_line", first, "call_path entry should have function_at_line")
        self.assertIsInstance(first["function_at_line"], int)
