# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""End-to-end contract tests for the OTel Lite SDK Lambda mode (Node.js distro).

Ported from the Python distro's lite SDK contract tests
(aws-observability/aws-otel-python-instrumentation#789), adapted to the Node.js
distro's contract-test conventions and the JS lite SDK's actual wire output.

The sample application is a Node.js app (contract-tests/images/applications/
lambda-lite-sdk) bootstrapped through the distro's `register` entrypoint with
AWS_LAMBDA_LITE_MODE=true, so it exercises the same configureLiteMode() path the
Lambda layer uses. It exports spans over UDP to a mock collector that mimics the
X-Ray daemon, then we assert on what the collector decoded.

Tests verify that:
- Spans are emitted via UDP in the correct OTLP format
- Application Signals attributes are injected correctly
- Sampled prefixes (T1S) are used correctly
- Parent-child span relationships are preserved
- Resource attributes are encoded
- Span timing is sane
- Multiple invocations produce distinct traces

The JS encoder was aligned with the Python lite SDK so these tests assert the
same wire behavior: it groups spans by instrumentation scope into separate
ScopeSpans and writes the OTLP Span `flags` field (trace flags | HAS_IS_REMOTE).
"""
import time
from logging import INFO, Logger, getLogger
from typing import Dict, List
from unittest import TestCase

from docker import DockerClient
from docker.models.networks import Network, NetworkCollection
from docker.types import EndpointConfig
from requests import request
from testcontainers.core.container import DockerContainer
from testcontainers.core.waiting_utils import wait_for_logs

NETWORK_NAME: str = "lite-sdk-test-network"
_MOCK_UDP_COLLECTOR_ALIAS: str = "udp-collector"
_MOCK_UDP_COLLECTOR_NAME: str = "mock-udp-collector"
_MOCK_UDP_COLLECTOR_HTTP_PORT: int = 8080
# Image name follows the Node.js contract-test convention used by
# scripts/set-up-contract-tests.sh: aws-application-signals-tests-<app>-app
_APPLICATION_IMAGE: str = "aws-application-signals-tests-lambda-lite-sdk-app"
_APPLICATION_ALIAS: str = "lambda-lite-sdk"
_APPLICATION_PORT: int = 8080

_logger: Logger = getLogger(__name__)
_logger.setLevel(INFO)


class LiteSdkContractTest(TestCase):
    """E2E contract tests for the Node.js OTel Lite SDK."""

    application: DockerContainer
    mock_collector: DockerContainer
    network: Network

    @classmethod
    def setUpClass(cls) -> None:
        cls.addClassCleanup(cls.class_tear_down)
        cls.network = NetworkCollection(client=DockerClient()).create(NETWORK_NAME)

        collector_networking_config: Dict[str, EndpointConfig] = {
            NETWORK_NAME: EndpointConfig(version="1.22", aliases=[_MOCK_UDP_COLLECTOR_ALIAS])
        }
        cls.mock_collector = (
            DockerContainer(_MOCK_UDP_COLLECTOR_NAME)
            .with_exposed_ports(_MOCK_UDP_COLLECTOR_HTTP_PORT)
            .with_name(_MOCK_UDP_COLLECTOR_NAME)
            .with_kwargs(network=NETWORK_NAME, networking_config=collector_networking_config)
        )
        cls.mock_collector.start()
        wait_for_logs(cls.mock_collector, "Ready", timeout=20)

    @classmethod
    def class_tear_down(cls) -> None:
        try:
            _logger.info("MockUdpCollector stdout: %s", cls.mock_collector.get_logs()[0].decode())
            cls.mock_collector.stop()
        except Exception:  # pylint: disable=broad-exception-caught
            _logger.exception("Failed to tear down mock UDP collector")
        cls.network.remove()

    def setUp(self) -> None:
        self.addCleanup(self.tear_down)
        app_networking_config: Dict[str, EndpointConfig] = {
            NETWORK_NAME: EndpointConfig(version="1.22", aliases=[_APPLICATION_ALIAS])
        }
        self.application = (
            DockerContainer(_APPLICATION_IMAGE)
            .with_exposed_ports(_APPLICATION_PORT)
            .with_env("AWS_LAMBDA_LITE_MODE", "true")
            .with_env("AWS_LAMBDA_FUNCTION_NAME", "my-function")
            .with_env("AWS_REGION", "us-west-2")
            .with_env("OTEL_SERVICE_NAME", "my-function")
            .with_env("OTEL_RESOURCE_ATTRIBUTES", "cloud.region=us-west-2,cloud.platform=aws_lambda,cloud.provider=aws")
            .with_env("OTEL_AWS_APPLICATION_SIGNALS_ENABLED", "true")
            .with_env("AWS_XRAY_DAEMON_ADDRESS", f"{_MOCK_UDP_COLLECTOR_ALIAS}:2000")
            .with_name(_APPLICATION_ALIAS)
            .with_kwargs(network=NETWORK_NAME, networking_config=app_networking_config)
        )
        self.application.start()
        wait_for_logs(self.application, "Ready", timeout=20)
        self._clear_collector()

    def tear_down(self) -> None:
        try:
            _logger.info("Application stdout: %s", self.application.get_logs()[0].decode())
            self.application.stop()
        except Exception:  # pylint: disable=broad-exception-caught
            _logger.exception("Failed to tear down application")
        self._clear_collector()

    def _get_collector_url(self) -> str:
        host = self.mock_collector.get_container_host_ip()
        port = self.mock_collector.get_exposed_port(_MOCK_UDP_COLLECTOR_HTTP_PORT)
        return f"http://{host}:{port}"

    def _get_spans(self, timeout: float = 10.0) -> List[dict]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            resp = request("GET", f"{self._get_collector_url()}/spans", timeout=5)
            spans = resp.json()
            if spans:
                return spans
            time.sleep(0.5)
        return []

    def _clear_collector(self) -> None:
        try:
            request("DELETE", f"{self._get_collector_url()}/spans", timeout=5)
        except Exception:  # pylint: disable=broad-exception-caught
            pass

    def _invoke(self) -> dict:
        host = self.application.get_container_host_ip()
        port = self.application.get_exposed_port(_APPLICATION_PORT)
        resp = request("GET", f"http://{host}:{port}/invoke", timeout=10)
        return resp.json()

    def test_spans_emitted_via_udp(self):
        """Verify spans arrive at the mock UDP collector."""
        self._invoke()
        spans = self._get_spans()
        self.assertGreater(len(spans), 0, "No spans received by UDP collector")

    def test_multiple_scopes_grouped_correctly(self):
        """Verify spans from different instrumentors have distinct scope names."""
        self._invoke()
        spans = self._get_spans()
        scope_names = {s["scope_name"] for s in spans}
        self.assertIn("opentelemetry.instrumentation.aws_lambda", scope_names)
        self.assertIn("opentelemetry.instrumentation.aws-sdk", scope_names)

    def test_parent_child_relationship(self):
        """Verify the child CLIENT span references the parent SERVER span ID."""
        self._invoke()
        spans = self._get_spans()
        server_spans = [s for s in spans if s["kind"] == 2]  # SERVER
        client_spans = [s for s in spans if s["kind"] == 3]  # CLIENT
        self.assertEqual(len(server_spans), 1)
        self.assertEqual(len(client_spans), 1)

        server = server_spans[0]
        client = client_spans[0]
        self.assertEqual(client["trace_id"], server["trace_id"])
        self.assertEqual(client["parent_span_id"], server["span_id"])

    def test_app_signals_attributes_injected(self):
        """Verify Application Signals attributes are present on the SERVER span."""
        self._invoke()
        spans = self._get_spans()
        server_spans = [s for s in spans if s["kind"] == 2]
        self.assertEqual(len(server_spans), 1)
        attrs = server_spans[0]["attributes"]
        self.assertEqual(attrs.get("aws.local.service"), "my-function")
        self.assertEqual(attrs.get("aws.local.operation"), "my-function/FunctionHandler")
        self.assertEqual(attrs.get("aws.local.environment"), "lambda:default")

    def test_client_span_remote_attributes(self):
        """Verify remote service/operation attributes on the CLIENT span."""
        self._invoke()
        spans = self._get_spans()
        client_spans = [s for s in spans if s["kind"] == 3]
        self.assertEqual(len(client_spans), 1)
        attrs = client_spans[0]["attributes"]
        self.assertEqual(attrs.get("aws.remote.service"), "AWS::S3")
        self.assertEqual(attrs.get("aws.remote.operation"), "ListBuckets")

    def test_sampled_prefix_used(self):
        """Verify the T1S prefix is used (root spans are always sampled)."""
        self._invoke()
        spans = self._get_spans()
        self.assertGreater(len(spans), 0)
        for span in spans:
            self.assertEqual(span["prefix"], "T1S")

    def test_span_flags_encoded(self):
        """Verify the span flags field sets HAS_IS_REMOTE and the sampled bit."""
        self._invoke()
        spans = self._get_spans()
        self.assertGreater(len(spans), 0)
        for span in spans:
            flags = span["flags"]
            self.assertTrue(flags & 0x100, "HAS_IS_REMOTE bit not set")
            self.assertTrue(flags & 0x01, "Sampled bit not set for root spans")

    def test_resource_attributes_present(self):
        """Verify resource attributes are encoded in the OTLP payload."""
        self._invoke()
        spans = self._get_spans()
        self.assertGreater(len(spans), 0)
        resource = spans[0]["resource"]
        self.assertEqual(resource.get("service.name"), "my-function")
        self.assertEqual(resource.get("cloud.region"), "us-west-2")

    def test_span_timing(self):
        """Verify start_time and end_time are populated and sensible."""
        self._invoke()
        spans = self._get_spans()
        # Guard against the loop passing vacuously when no spans arrived.
        self.assertGreater(len(spans), 0, "No spans received by UDP collector")
        for span in spans:
            self.assertGreater(span["start_time"], 0)
            self.assertGreater(span["end_time"], 0)
            self.assertGreaterEqual(span["end_time"], span["start_time"])

    def test_multiple_invocations(self):
        """Verify multiple invocations each produce a separate trace."""
        self._invoke()
        self._invoke()
        self._invoke()
        spans = self._get_spans()
        trace_ids = {s["trace_id"] for s in spans}
        self.assertGreaterEqual(len(trace_ids), 3, "Expected at least 3 distinct trace IDs")
