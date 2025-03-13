# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
from typing import Dict, List

from mock_collector_client import ResourceScopeMetric, ResourceScopeSpan
from requests import Response, request
from typing_extensions import override

from amazon.base.contract_test_base import ContractTestBase
from amazon.utils.application_signals_constants import ERROR_METRIC, FAULT_METRIC, LATENCY_METRIC
from opentelemetry.proto.common.v1.common_pb2 import AnyValue
from opentelemetry.proto.metrics.v1.metrics_pb2 import Metric
from opentelemetry.proto.trace.v1.trace_pb2 import Span


def _get_k8s_attributes():
    return {
        "k8s.namespace.name": "namespace-name",
        "k8s.pod.name": "pod-name",
        "k8s.deployment.name": "deployment-name",
    }


# Tests consuming this class are supposed to validate that the agent is able to get the resource
# attributes through the environment variables OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME
#
# These tests are structured with nested classes since it is only possible to change the
# resource attributes during the initialization of the OpenTelemetry SDK.


class ResourceAttributesTest(ContractTestBase):
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

    def do_test_resource_attributes(self, service_name):
        address: str = self.application.get_container_host_ip()
        port: str = self.application.get_exposed_port(self.get_application_port())
        url: str = f"http://{address}:{port}/success"
        response: Response = request("GET", url, timeout=20)
        self.assertEqual(200, response.status_code)
        self.assert_resource_attributes(service_name)

    def assert_resource_attributes(self, service_name):
        resource_scope_spans: List[ResourceScopeSpan] = self.mock_collector_client.get_traces()
        metrics: List[ResourceScopeMetric] = self.mock_collector_client.get_metrics(
            {LATENCY_METRIC, ERROR_METRIC, FAULT_METRIC}
        )
        target_spans: List[Span] = []
        for resource_scope_span in resource_scope_spans:
            # pylint: disable=no-member
            if resource_scope_span.span.name == "GET" and resource_scope_span.span.kind == Span.SPAN_KIND_CLIENT:
                target_spans.append(resource_scope_span.resource_spans)

        self.assertEqual(len(target_spans), 1)
        attributes_dict: Dict[str, AnyValue] = self._get_attributes_dict(target_spans[0].resource.attributes)
        for key, value in _get_k8s_attributes().items():
            self._assert_str_attribute(attributes_dict, key, value)
        self._assert_str_attribute(attributes_dict, "service.name", service_name)

        target_metrics: List[Metric] = []
        for resource_scope_metric in metrics:
            if resource_scope_metric.metric.name in ["Error", "Fault", "Latency"]:
                target_metrics.append(resource_scope_metric.resource_metrics)
        self.assertEqual(len(target_metrics), 3)
        for target_metric in target_metrics:
            metric_attributes_dict: Dict[str, AnyValue] = self._get_attributes_dict(target_metric.resource.attributes)
            for key, value in _get_k8s_attributes().items():
                self._assert_str_attribute(metric_attributes_dict, key, value)
            self._assert_str_attribute(metric_attributes_dict, "service.name", service_name)
