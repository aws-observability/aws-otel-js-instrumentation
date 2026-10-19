# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
from typing import Dict, List

# from testcontainers.mysql import MySqlContainer
# from testcontainers.mongodb import MongoDbContainer
from testcontainers.core.container import DockerContainer
from typing_extensions import override

from amazon.base.contract_test_base import NETWORK_NAME
from amazon.base.database_contract_test_base import (
    DATABASE_HOST,
    DATABASE_PASSWORD,
    DATABASE_USER,
    SPAN_KIND_CLIENT,
    DatabaseContractTestBase,
)
from amazon.utils.application_signals_constants import (
    AWS_LOCAL_OPERATION,
    AWS_LOCAL_SERVICE,
    AWS_REMOTE_OPERATION,
    AWS_REMOTE_RESOURCE_IDENTIFIER,
    AWS_REMOTE_RESOURCE_TYPE,
    AWS_REMOTE_SERVICE,
    AWS_SPAN_KIND,
)
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue


class MongooseTest(DatabaseContractTestBase):
    @override
    @classmethod
    def set_up_dependency_container(cls) -> None:
        cls.container = (
            DockerContainer("mongo:7.0.9")
            .with_env("MONGO_INITDB_ROOT_USERNAME", DATABASE_USER)
            .with_env("MONGO_INITDB_ROOT_PASSWORD", DATABASE_PASSWORD)
            .with_kwargs(network=NETWORK_NAME)
            .with_name(DATABASE_HOST)
        )
        cls.container.start()

    @override
    @classmethod
    def tear_down_dependency_container(cls) -> None:
        cls.container.stop()

    @override
    @staticmethod
    def get_remote_service() -> str:
        return "mongoose"

    @override
    @staticmethod
    def get_database_port() -> int:
        return 27017

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return "aws-application-signals-tests-mongoose-app"

    def test_find_document_succeeds(self) -> None:
        self.assert_find_document_succeeds(local_operation='GET /find', span_name='mongoose.Employee.find', db_operation='find')

    def test_delete_document_succeeds(self) -> None:
        self.assert_delete_document_succeeds(local_operation='GET /delete_document', span_name='mongoose.Employee.deleteOne', db_operation='deleteOne')

    def test_insert_document_succeeds(self) -> None:
        self.assert_insert_document_succeeds(local_operation='GET /insert_document', span_name='mongoose.Employee.save', db_operation='save')

    def test_update_document_succeeds(self) -> None:
        self.assert_update_document_succeeds(local_operation='GET /update_document', span_name='mongoose.Employee.findOneAndUpdate', db_operation='findOneAndUpdate')
    

    @override
    def _assert_aws_attributes(
        self, attributes_list: List[KeyValue], expected_span_kind: str = SPAN_KIND_CLIENT, **kwargs
    ) -> None:
        attributes_dict: Dict[str, AnyValue] = self._get_attributes_dict(attributes_list)
        self._assert_str_attribute(attributes_dict, AWS_LOCAL_SERVICE, self.get_application_otel_service_name())
        self._assert_str_attribute(attributes_dict, AWS_LOCAL_OPERATION, kwargs.get("local_operation"))
        self._assert_str_attribute(attributes_dict, AWS_REMOTE_SERVICE, self.get_remote_service())
        self._assert_str_attribute(attributes_dict, AWS_REMOTE_OPERATION, kwargs.get("db_operation"))
        self._assert_str_attribute(attributes_dict, AWS_REMOTE_RESOURCE_TYPE, "DB::Connection")
        self._assert_str_attribute(
            attributes_dict, AWS_REMOTE_RESOURCE_IDENTIFIER, self.get_remote_resource_identifier()
        )
        self._assert_str_attribute(attributes_dict, AWS_SPAN_KIND, expected_span_kind)

    @override
    def _assert_semantic_conventions_attributes(self, attributes_list: List[KeyValue], **kwargs) -> None:
        attributes_dict: Dict[str, AnyValue] = self._get_attributes_dict(attributes_list)
        self._assert_str_attribute(attributes_dict, "db.mongodb.collection", "employees")
        self._assert_str_attribute(attributes_dict, "db.system", self.get_remote_service())
        self._assert_str_attribute(attributes_dict, "db.name", "testdb")
        self._assert_str_attribute(attributes_dict, "net.peer.name", "mydb")
        self._assert_int_attribute(attributes_dict, "net.peer.port", self.get_database_port())
        self._assert_str_attribute(attributes_dict, "db.operation", kwargs.get("db_operation"))
        self.assertTrue("db.statement" not in attributes_dict)
        self.assertTrue("db.user" not in attributes_dict)
        self.assertTrue("server.address" not in attributes_dict)
        self.assertTrue("server.port" not in attributes_dict)
