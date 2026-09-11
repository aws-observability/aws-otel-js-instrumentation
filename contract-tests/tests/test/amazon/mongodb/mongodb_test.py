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


class MongodbTest(DatabaseContractTestBase):
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
        return "mongodb"

    @override
    @staticmethod
    def get_database_port() -> int:
        return 27017

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return "aws-application-signals-tests-mongodb-app"

    def test_find_document_succeeds(self) -> None:
        self.assert_find_document_succeeds(local_operation='GET /find', span_name='find employees', db_operation='find', db_statement='statement')

    def test_delete_document_succeeds(self) -> None:
        self.assert_delete_document_succeeds(local_operation='GET /delete_document', span_name='delete employees', db_operation='delete')

    def test_insert_document_succeeds(self) -> None:
        self.assert_insert_document_succeeds(local_operation='GET /insert_document', span_name='insert employees', db_operation='insert')

    def test_update_document_succeeds(self) -> None:
        # We don't know why "db.collection.name" is set to "$cmd". It's probably a bug in upstream.
        self.assert_update_document_succeeds(local_operation='GET /update_document', span_name='findAndModify $cmd', db_operation='findAndModify', mongodb_collection='$cmd')

    
    def test_fault(self) -> None:
        # We don't know why "db.collection.name" is set to "$cmd". It's probably a bug in upstream.
        self.assert_fault_non_sql(local_operation='GET /fault', span_name='invalidCommand $cmd', db_operation='invalidCommand', mongodb_collection='$cmd')

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
        # We might need to revisit the assertation here
        # Currently the value is 'testdb|172.31.0.3|27017' not the expected one 'testdb|mydb|27017'
        # self._assert_str_attribute(
        #     attributes_dict, AWS_REMOTE_RESOURCE_IDENTIFIER, self.get_remote_resource_identifier()
        # )
        self._assert_str_attribute(attributes_dict, AWS_SPAN_KIND, expected_span_kind)

    @override
    def _assert_semantic_conventions_attributes(self, attributes_list: List[KeyValue], **kwargs) -> None:
        attributes_dict: Dict[str, AnyValue] = self._get_attributes_dict(attributes_list)
        self._assert_str_attribute(attributes_dict, "db.collection.name", kwargs.get("mongodb_collection") or "employees")
        self._assert_str_attribute(attributes_dict, "db.system.name", self.get_remote_service())
        self._assert_str_attribute(attributes_dict, "db.namespace", "testdb")
        # server.address is currently an IP address rather than the configured hostname.
        self.assertTrue("server.address" in attributes_dict)
        self._assert_int_attribute(attributes_dict, "server.port", self.get_database_port())
        self._assert_str_attribute(attributes_dict, "db.operation.name", kwargs.get("db_operation"))
        self.assertTrue("db.query.text" in attributes_dict)
        self.assertTrue("db.user" not in attributes_dict)
        self.assertTrue("db.mongodb.collection" not in attributes_dict)
        self.assertTrue("db.system" not in attributes_dict)
        self.assertTrue("db.name" not in attributes_dict)
        self.assertTrue("net.peer.name" not in attributes_dict)
        self.assertTrue("net.peer.port" not in attributes_dict)
        self.assertTrue("db.operation" not in attributes_dict)
        self.assertTrue("db.statement" not in attributes_dict)
