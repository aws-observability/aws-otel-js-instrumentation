# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
from typing import Dict, List

from mock_collector_client import ResourceScopeMetric, ResourceScopeSpan
from typing_extensions import override

from amazon.base.contract_test_base import ContractTestBase
from amazon.utils.application_signals_constants import (
    AWS_LOCAL_OPERATION,
    AWS_LOCAL_SERVICE,
    AWS_REMOTE_DB_USER,
    AWS_REMOTE_OPERATION,
    AWS_REMOTE_RESOURCE_IDENTIFIER,
    AWS_REMOTE_RESOURCE_TYPE,
    AWS_REMOTE_SERVICE,
    AWS_SPAN_KIND,
)
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
from opentelemetry.proto.metrics.v1.metrics_pb2 import ExponentialHistogramDataPoint, Metric
from opentelemetry.proto.trace.v1.trace_pb2 import Span
from opentelemetry.trace import StatusCode

DATABASE_HOST: str = "mydb"
DATABASE_NAME: str = "testdb"
DATABASE_PASSWORD: str = "example"
DATABASE_USER: str = "root"
SPAN_KIND_CLIENT: str = "CLIENT"
SPAN_KIND_LOCAL_ROOT: str = "LOCAL_ROOT"


class DatabaseContractTestBase(ContractTestBase):
    @staticmethod
    def get_remote_service() -> str:
        return None

    @staticmethod
    def get_database_port() -> int:
        return None

    def get_remote_resource_identifier(self) -> str:
        return f"{DATABASE_NAME}|{DATABASE_HOST}|{self.get_database_port()}"

    @override
    def get_application_extra_environment_variables(self) -> Dict[str, str]:
        return {
            "DB_HOST": DATABASE_HOST,
            "DB_USER": DATABASE_USER,
            "DB_PASS": DATABASE_PASSWORD,
            "DB_NAME": DATABASE_NAME,
        }

    # define tests for SQL database
    def assert_drop_table_succeeds(self) -> None:
        self.mock_collector_client.clear_signals()
        self.do_test_requests("drop_table", "GET", 200, 0, 0, sql_command="DROP TABLE", local_operation="GET /drop_table", span_name="DROP")

    def assert_create_database_succeeds(self) -> None:
        self.mock_collector_client.clear_signals()
        self.do_test_requests("create_database", "GET", 200, 0, 0, sql_command="CREATE DATABASE", local_operation="GET /create_database", span_name="CREATE")

    def assert_select_succeeds(self) -> None:
        self.mock_collector_client.clear_signals()
        self.do_test_requests("select", "GET", 200, 0, 0, sql_command="SELECT", local_operation="GET /select", span_name="SELECT")

    def assert_fault(self) -> None:
        self.mock_collector_client.clear_signals()
        self.do_test_requests("fault", "GET", 500, 0, 1, sql_command="SELECT DISTINCT", local_operation="GET /fault", span_name="SELECT")

    # define tests for MongoDB database
    def assert_delete_document_succeeds(self, **kwargs) -> None:
        self.mock_collector_client.clear_signals()
        self.do_test_requests("delete_document", "GET", 200, 0, 0, **kwargs)

    def assert_insert_document_succeeds(self, **kwargs) -> None:
        self.mock_collector_client.clear_signals()
        self.do_test_requests("insert_document", "GET", 200, 0, 0, **kwargs)

    def assert_update_document_succeeds(self, **kwargs) -> None:
        self.mock_collector_client.clear_signals()
        self.do_test_requests("update_document", "GET", 200, 0, 0, **kwargs)

    def assert_find_document_succeeds(self, **kwargs) -> None:
        self.mock_collector_client.clear_signals()
        self.do_test_requests("find", "GET", 200, 0, 0, **kwargs)

    def assert_fault_non_sql(self, **kwargs) -> None:
        self.mock_collector_client.clear_signals()
        self.do_test_requests("fault", "GET", 500, 0, 1, **kwargs)

    @override
    def _assert_aws_span_attributes(self, resource_scope_spans: List[ResourceScopeSpan], path: str, **kwargs) -> None:
        target_spans: List[Span] = []
        for resource_scope_span in resource_scope_spans:
            # pylint: disable=no-member
            if resource_scope_span.span.kind == Span.SPAN_KIND_CLIENT:
                target_spans.append(resource_scope_span.span)

        self.assertEqual(
            len(target_spans), 1, f"target_spans is {str(target_spans)}, although only one walue was expected"
        )
        self._assert_aws_attributes(target_spans[0].attributes, **kwargs)

    @override
    def _assert_semantic_conventions_span_attributes(
        self, resource_scope_spans: List[ResourceScopeSpan], method: str, path: str, status_code: int, **kwargs
    ) -> None:
        target_spans: List[Span] = []
        for resource_scope_span in resource_scope_spans:
            # pylint: disable=no-member
            if resource_scope_span.span.kind == Span.SPAN_KIND_CLIENT:
                target_spans.append(resource_scope_span.span)

        self.assertEqual(target_spans[0].name, kwargs.get("span_name"))
        if status_code == 200:
            self.assertEqual(target_spans[0].status.code, StatusCode.UNSET.value)
        else:
            self.assertEqual(target_spans[0].status.code, StatusCode.ERROR.value)

        self._assert_semantic_conventions_attributes(target_spans[0].attributes, **kwargs)

    def _assert_semantic_conventions_attributes(self, attributes_list: List[KeyValue], **kwargs) -> None:
        attributes_dict: Dict[str, AnyValue] = self._get_attributes_dict(attributes_list)
        command = kwargs.get("db_operation") or kwargs.get("sql_command")
        self.assertTrue(attributes_dict.get("db.statement").string_value.startswith(command))
        self._assert_str_attribute(attributes_dict, "db.system", self.get_remote_service())
        self._assert_str_attribute(attributes_dict, "db.name", DATABASE_NAME)
        self._assert_str_attribute(attributes_dict, "net.peer.name", DATABASE_HOST)
        self._assert_int_attribute(attributes_dict, "net.peer.port", self.get_database_port())
        self.assertTrue("server.address" not in attributes_dict)
        self.assertTrue("server.port" not in attributes_dict)
        self.assertTrue("db.operation" not in attributes_dict)

    @override
    def _assert_aws_attributes(
        self, attributes_list: List[KeyValue], expected_span_kind: str = SPAN_KIND_CLIENT, **kwargs
    ) -> None:
        attributes_dict: Dict[str, AnyValue] = self._get_attributes_dict(attributes_list)
        self._assert_str_attribute(attributes_dict, AWS_LOCAL_SERVICE, self.get_application_otel_service_name())
        self._assert_str_attribute(attributes_dict, AWS_LOCAL_OPERATION, kwargs.get("local_operation"))
        self._assert_str_attribute(attributes_dict, AWS_REMOTE_SERVICE, self.get_remote_service())
        self._assert_str_attribute(attributes_dict, AWS_REMOTE_OPERATION, kwargs.get("sql_command"))
        self._assert_str_attribute(attributes_dict, AWS_REMOTE_RESOURCE_TYPE, "DB::Connection")
        self._assert_str_attribute(attributes_dict, AWS_REMOTE_DB_USER, DATABASE_USER)
        self._assert_str_attribute(
            attributes_dict, AWS_REMOTE_RESOURCE_IDENTIFIER, self.get_remote_resource_identifier()
        )
        self._assert_str_attribute(attributes_dict, AWS_SPAN_KIND, expected_span_kind)

    @override
    def _assert_metric_attributes(
        self, resource_scope_metrics: List[ResourceScopeMetric], metric_name: str, expected_sum: int, **kwargs
    ) -> None:
        target_metrics: List[Metric] = []
        for resource_scope_metric in resource_scope_metrics:
            if resource_scope_metric.metric.name.lower() == metric_name.lower():
                target_metrics.append(resource_scope_metric.metric)
        self.assertLessEqual(
            len(target_metrics),
            2,
            f"target_metrics is {str(target_metrics)}, although we expect less than or equal to 2 metrics",
        )
        dp_list: List[ExponentialHistogramDataPoint] = [
            dp for target_metric in target_metrics for dp in target_metric.exponential_histogram.data_points
        ]
        self.assertEqual(len(dp_list), 2)
        dependency_dp: ExponentialHistogramDataPoint = dp_list[0]
        service_dp: ExponentialHistogramDataPoint = dp_list[1]
        if len(dp_list[1].attributes) > len(dp_list[0].attributes):
            dependency_dp = dp_list[1]
            service_dp = dp_list[0]
        self._assert_aws_attributes(dependency_dp.attributes, SPAN_KIND_CLIENT, **kwargs)
        self.check_sum(metric_name, dependency_dp.sum, expected_sum)

        attribute_dict: Dict[str, AnyValue] = self._get_attributes_dict(service_dp.attributes)
        self._assert_str_attribute(attribute_dict, AWS_LOCAL_OPERATION,kwargs.get("local_operation"))
        self._assert_str_attribute(attribute_dict, AWS_SPAN_KIND, SPAN_KIND_LOCAL_ROOT)
        self.check_sum(metric_name, service_dp.sum, expected_sum)
