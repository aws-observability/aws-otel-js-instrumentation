# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
from typing import Dict, List

from testcontainers.mysql import MySqlContainer
from typing_extensions import override

from amazon.base.contract_test_base import NETWORK_NAME
from amazon.base.database_contract_test_base import (
    DATABASE_HOST,
    DATABASE_NAME,
    DATABASE_PASSWORD,
    DATABASE_USER,
    DatabaseContractTestBase,
)


class Mysql2Test(DatabaseContractTestBase):
    @override
    @classmethod
    def set_up_dependency_container(cls) -> None:
        cls.container = (
            MySqlContainer(MYSQL_USER=DATABASE_USER, MYSQL_PASSWORD=DATABASE_PASSWORD, MYSQL_DATABASE=DATABASE_NAME)
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
        return "mysql"

    @override
    @staticmethod
    def get_database_port() -> int:
        return 3306

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return "aws-application-signals-tests-mysql2-app"

    def test_select_succeeds(self) -> None:
        self.assert_select_succeeds()

    def test_drop_table_succeeds(self) -> None:
        self.assert_drop_table_succeeds()

    def test_create_database_succeeds(self) -> None:
        self.assert_create_database_succeeds()

    def test_fault(self) -> None:
        self.assert_fault()

