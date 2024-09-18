# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
from typing import Dict, List
from logging import INFO, Logger, getLogger

from mock_collector_client import ResourceScopeMetric, ResourceScopeSpan
from typing_extensions import override

from amazon.base.contract_test_base import ContractTestBase
from amazon.utils.application_signals_constants import (
    AWS_LOCAL_OPERATION,
    AWS_LOCAL_SERVICE,
    AWS_REMOTE_OPERATION,
    AWS_REMOTE_SERVICE,
    AWS_SPAN_KIND,
)
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
from opentelemetry.proto.metrics.v1.metrics_pb2 import ExponentialHistogramDataPoint, Metric
from opentelemetry.proto.trace.v1.trace_pb2 import Span
from opentelemetry.semconv.trace import SpanAttributes

_logger: Logger = getLogger(__name__)
_logger.setLevel(INFO)

class HttpTest(ContractTestBase):
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

    @override
    def get_application_extra_environment_variables(self) -> Dict[str, str]:
        """
        This does not appear to do anything, as it does not seem that OTEL supports peer service for Python. Keeping
        for consistency with Java contract tests at this time.
        """
        return {"OTEL_INSTRUMENTATION_COMMON_PEER_SERVICE_MAPPING": "backend=backend:8080"}

    def test_success(self) -> None:
        self.do_test_requests("success", "GET", 200, 0, 0, request_method="GET", path_suffix="/success")

    def test_error(self) -> None:
        self.do_test_requests("error", "GET", 400, 1, 0, request_method="GET", path_suffix="/error")

    def test_fault(self) -> None:
        self.do_test_requests("fault", "GET", 500, 0, 1, request_method="GET", path_suffix="/fault")

    def test_success_post(self) -> None:
        self.do_test_requests("success/postmethod", "POST", 200, 0, 0, request_method="POST", path_suffix="/success")

    def test_error_post(self) -> None:
        self.do_test_requests("error/postmethod", "POST", 400, 1, 0, request_method="POST", path_suffix="/error")

    def test_fault_post(self) -> None:
        self.do_test_requests("fault/postmethod", "POST", 500, 0, 1, request_method="POST", path_suffix="/fault")

    @override
    def _assert_aws_span_attributes(self, resource_scope_spans: List[ResourceScopeSpan], path: str, **kwargs) -> None:
        target_spans: List[Span] = []
        for resource_scope_span in resource_scope_spans:
            # pylint: disable=no-member
            if resource_scope_span.span.kind == Span.SPAN_KIND_CLIENT:
                target_spans.append(resource_scope_span.span)

        self.assertEqual(len(target_spans), 1)
        _logger.info(target_spans[0].attributes)
        self._assert_aws_attributes(target_spans[0].attributes, kwargs.get("request_method"), kwargs.get("path_suffix"))

    def _assert_aws_attributes(self, attributes_list: List[KeyValue], method: str, endpoint: str) -> None:
        attributes_dict: Dict[str, AnyValue] = self._get_attributes_dict(attributes_list)
        self._assert_str_attribute(attributes_dict, AWS_LOCAL_SERVICE, self.get_application_otel_service_name())
        self._assert_str_attribute(attributes_dict, AWS_LOCAL_OPERATION, f"{method} {endpoint}")
        self._assert_str_attribute(attributes_dict, AWS_REMOTE_SERVICE, "backend:8080")
        self._assert_str_attribute(attributes_dict, AWS_REMOTE_OPERATION, f"{method} /backend")
        self._assert_str_attribute(attributes_dict, AWS_SPAN_KIND, "CLIENT")

    @override
    def _assert_semantic_conventions_span_attributes(
        self, resource_scope_spans: List[ResourceScopeSpan], method: str, path: str, status_code: int, **kwargs
    ) -> None:
        target_spans: List[Span] = []
        for resource_scope_span in resource_scope_spans:
            # pylint: disable=no-member
            if resource_scope_span.span.kind == Span.SPAN_KIND_CLIENT:
                target_spans.append(resource_scope_span.span)

        self.assertEqual(len(target_spans), 1)
        self.assertEqual(target_spans[0].name, method)
        self._assert_semantic_conventions_attributes(target_spans[0].attributes, method, path, status_code)

    def _assert_semantic_conventions_attributes(
        self, attributes_list: List[KeyValue], method: str, endpoint: str, status_code: int
    ) -> None:
        attributes_dict: Dict[str, AnyValue] = self._get_attributes_dict(attributes_list)
        self._assert_str_attribute(attributes_dict, SpanAttributes.NET_PEER_NAME, "backend")
        self._assert_int_attribute(attributes_dict, SpanAttributes.NET_PEER_PORT, 8080)
        self._assert_int_attribute(attributes_dict, SpanAttributes.HTTP_STATUS_CODE, status_code)
        self._assert_str_attribute(attributes_dict, SpanAttributes.HTTP_URL, f"http://backend:8080/backend/{endpoint}")
        self._assert_str_attribute(attributes_dict, SpanAttributes.HTTP_METHOD, method)
        # http instrumentation is not respecting PEER_SERVICE
        # self._assert_str_attribute(attributes_dict, SpanAttributes.PEER_SERVICE, "backend:8080")

    @override
    def _assert_metric_attributes(
        self,
        resource_scope_metrics: List[ResourceScopeMetric],
        metric_name: str,
        expected_sum: int,
        **kwargs,
    ) -> None:
        target_metrics: List[Metric] = []
        for resource_scope_metric in resource_scope_metrics:
            if resource_scope_metric.metric.name.lower() == metric_name.lower():
                target_metrics.append(resource_scope_metric.metric)

        self.assertEqual(len(target_metrics), 1)
        target_metric: Metric = target_metrics[0]
        dp_list: List[ExponentialHistogramDataPoint] = target_metric.exponential_histogram.data_points


        self.assertEqual(len(dp_list), 3)

        # Find the data point with the longest attributes list and assign it to service_dp
        dependency_dp: ExponentialHistogramDataPoint = max(dp_list, key=lambda dp: len(dp.attributes))
        # Assign the remaining two elements to dependency_dp and other_dp
        remaining_dps = [dp for dp in dp_list if dp != dependency_dp]
        service_dp, other_dp = remaining_dps[0], remaining_dps[1]


        _logger.info("DEBUG: data point 1")
        attribute_dict: Dict[str, AnyValue] = self._get_attributes_dict(dependency_dp.attributes)
        method: str = kwargs.get("request_method")
        path_suffix: str = kwargs.get("path_suffix")
        self._assert_str_attribute(attribute_dict, AWS_LOCAL_SERVICE, self.get_application_otel_service_name())
        self._assert_str_attribute(attribute_dict, AWS_LOCAL_OPERATION, f"{method} {path_suffix}")
        self._assert_str_attribute(attribute_dict, AWS_REMOTE_SERVICE, "backend:8080")
        self._assert_str_attribute(attribute_dict, AWS_REMOTE_OPERATION, f"{method} /backend")
        self._assert_str_attribute(attribute_dict, AWS_SPAN_KIND, "CLIENT")
        self.check_sum(metric_name, dependency_dp.sum, expected_sum)

        attribute_dict_service: Dict[str, AnyValue] = self._get_attributes_dict(service_dp.attributes)
        attribute_dict_other: Dict[str, AnyValue] = self._get_attributes_dict(other_dp.attributes)

        # test AWS_LOCAL_OPERATION to be either "/backend" or "/success" in service_dp and other_dp
        if f"{method} /backend" not in [attribute_dict_service.get(AWS_LOCAL_OPERATION), attribute_dict_other.get(AWS_LOCAL_OPERATION)]:
            self._assert_str_attribute(attribute_dict_service, AWS_LOCAL_OPERATION, f"{method} /backend")
            self._assert_str_attribute(attribute_dict_other, AWS_LOCAL_OPERATION, f"{method} {path_suffix}")
        else:
            self._assert_str_attribute(attribute_dict_service, AWS_LOCAL_OPERATION, f"{method} {path_suffix}")
            self._assert_str_attribute(attribute_dict_other, AWS_LOCAL_OPERATION, f"{method} /backend")

        # Check additional attributes for service_dp
        self._assert_str_attribute(attribute_dict_service, AWS_SPAN_KIND, "LOCAL_ROOT")
        self.check_sum(metric_name, service_dp.sum, expected_sum)

        self._assert_str_attribute(attribute_dict_other, AWS_SPAN_KIND, "LOCAL_ROOT")
        self.check_sum(metric_name, other_dp.sum, expected_sum)
