# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
import time
from typing import Dict, List

from mock_collector_client import ResourceScopeMetric, ResourceScopeSpan
from requests import Response, request
from typing_extensions import override

from amazon.base.contract_test_base import ContractTestBase
from amazon.utils.application_signals_constants import ERROR_METRIC, FAULT_METRIC, LATENCY_METRIC
from opentelemetry.sdk.metrics.export import AggregationTemporality

# Tests in this class are supposed to validate that the SDK was configured in the correct way: It
# uses the X-Ray ID format. Metrics are deltaPreferred. Type of the metrics are exponentialHistogram


class ConfigurationTest(ContractTestBase):
    @override
    @staticmethod
    def get_application_image_name() -> str:
        return "aws-application-signals-tests-http-app"

    @override
    def get_application_network_aliases(self) -> List[str]:
        """
        This will be the target hostname of the clients making http requests in the application image, so that they
        don't use localhost.
        """
        return ["backend"]

    def test_configuration_metrics(self):
        address: str = self.application.get_container_host_ip()
        port: str = self.application.get_exposed_port(self.get_application_port())
        url: str = f"http://{address}:{port}/success"
        response: Response = request("GET", url, timeout=20)
        self.assertEqual(200, response.status_code)
        metrics: List[ResourceScopeMetric] = self.mock_collector_client.get_metrics(
            {LATENCY_METRIC, ERROR_METRIC, FAULT_METRIC}
        )

        self.assertEqual(len(metrics), 3)
        for metric in metrics:
            self.assertIsNotNone(metric.metric.exponential_histogram)
            self.assertEqual(metric.metric.exponential_histogram.aggregation_temporality, AggregationTemporality.DELTA)
        self.mock_collector_client.clear_signals()

    def test_xray_id_format(self):
        """
        We are testing here that the X-Ray id format is always used by inspecting the traceid that
        was in the span received by the collector, which should be consistent across multiple spans.
        We are testing the following properties:
        1. Traceid is random
        2. First 32 bits of traceid is a timestamp
        It is important to remember that the X-Ray traceId format had to be adapted to fit into the
        definition of the OpenTelemetry traceid:
        https://opentelemetry.io/docs/specs/otel/trace/api/#retrieving-the-traceid-and-spanid
        Specifically for an X-Ray traceid to be a valid Otel traceId, the version digit had to be
        dropped. Reference:
        https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/sdk-extension/opentelemetry-sdk-extension-aws/src/opentelemetry/sdk/extension/aws/trace/aws_xray_id_generator.py
        """

        seen: List[str] = []
        for _ in range(100):
            address: str = self.application.get_container_host_ip()
            port: str = self.application.get_exposed_port(self.get_application_port())
            url: str = f"http://{address}:{port}/success"
            response: Response = request("GET", url, timeout=20)
            self.assertEqual(200, response.status_code)

            # Since we just made the request, the time in epoch registered in the traceid should be
            # approximate equal to the current time in the test, since both run on the same host.
            start_time_sec: int = int(time.time())

            resource_scope_spans: List[ResourceScopeSpan] = self.mock_collector_client.get_traces()
            target_span: ResourceScopeSpan = resource_scope_spans[0]

            self.assertTrue(target_span.span.trace_id.hex() not in seen)
            seen.append(target_span.span.trace_id.hex())

            # trace_id is bytes, so we convert it to hex string and pick the first 8 byte
            # that represent the timestamp, then convert it to int for timestamp in second
            trace_id_time_stamp_int: int = int(target_span.span.trace_id.hex()[:8], 16)

            # Give 2 minutes time range of tolerance for the trace timestamp
            self.assertGreater(trace_id_time_stamp_int, start_time_sec - 60)
            self.assertGreater(start_time_sec + 60, trace_id_time_stamp_int)
            self.mock_collector_client.clear_signals()
