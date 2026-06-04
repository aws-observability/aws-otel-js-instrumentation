# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""DI contract tests for Express application via OTLP LogRecord verification.

NOTE: JS DI uses V8 Inspector which only supports line-level breakpoints.
All snapshots have captures.lines (not entry/return at method level).

Validates DI snapshots as OTLP LogRecords with:
  - Flat attributes: aws.di.snapshot_id, aws.di.method_name, aws.di.location_hash, etc.
  - Structured body: captures (lines with locals), stack
"""

import time

from typing_extensions import override

from amazon.di.di_contract_test_base import DITestInfrastructure

_APP_IMAGE = "aws-application-signals-tests-di-express-app"


class DIExpressBreakpointTest(DITestInfrastructure):
    """Test breakpoint on processData generates OTLP snapshot LogRecords."""

    __test__ = True

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    def test_snapshot_generated(self) -> None:
        response = self.send_request("GET", "success")
        self.assertEqual(200, response.status_code)

        snapshots = self.wait_for_snapshots(min_count=1)
        self.assertGreaterEqual(len(snapshots), 1)

        method_snaps = self.snapshots_for_method(snapshots, "processData")
        self.assertGreater(len(method_snaps), 0, "Expected snapshot for processData")

    def test_snapshot_has_required_attributes(self) -> None:
        self.send_request("GET", "success")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_method(snapshots, "processData")[0]

        attrs = self.log_attrs(snap)
        self.assertEqual(attrs.get("event.name"), "aws.dynamic_instrumentation.snapshot")
        self.assertIn("aws.di.snapshot_id", attrs)
        self.assertIn("aws.di.method_name", attrs)
        self.assertIn("aws.di.location_hash", attrs)
        self.assertIn("aws.di.instrumentation_level", attrs)

        # snapshot_id should be UUID format (36 chars)
        snapshot_id = attrs.get("aws.di.snapshot_id", "")
        self.assertEqual(36, len(snapshot_id), f"snapshot_id should be UUID format, got: {snapshot_id}")

    def test_snapshot_has_body_with_captures(self) -> None:
        self.send_request("GET", "success")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_method(snapshots, "processData")[0]

        body = self.log_body(snap)
        self.assertIsNotNone(body, "Body should not be None")
        self.assertIsInstance(body, dict, "Body should be a dict")
        self.assertIn("captures", body, "Body should have captures")

    def test_snapshot_has_correct_location(self) -> None:
        self.send_request("GET", "success")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_method(snapshots, "processData")[0]

        attrs = self.log_attrs(snap)
        self.assertEqual("processData", attrs.get("aws.di.method_name"))
        file_path = attrs.get("aws.di.file_path", "")
        self.assertTrue(file_path.endswith("app.js"), f"file_path should end with app.js, got: {file_path}")

    def test_snapshot_has_location_hash(self) -> None:
        self.send_request("GET", "success")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_method(snapshots, "processData")[0]

        attrs = self.log_attrs(snap)
        self.assertEqual("aabb000000000001", attrs.get("aws.di.location_hash"))

    def test_multiple_requests_generate_multiple_snapshots(self) -> None:
        for _ in range(3):
            self.send_request("GET", "success")

        snapshots = self.wait_for_snapshots(min_count=3)
        method_snaps = self.snapshots_for_method(snapshots, "processData")
        self.assertGreaterEqual(len(method_snaps), 3)


class DIExpressLineLevelTest(DITestInfrastructure):
    """Test line-level BREAKPOINT instrumentation via OTLP."""

    __test__ = True

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    def test_line_level_snapshot_generated(self) -> None:
        response = self.send_request("GET", "line-level")
        self.assertEqual(200, response.status_code)

        snapshots = self.wait_for_snapshots(min_count=1)
        line_snaps = self.snapshots_for_method(snapshots, "calculateSum")
        self.assertGreater(len(line_snaps), 0, "Expected snapshot for calculateSum")

    def test_line_level_snapshot_has_captures_lines(self) -> None:
        self.send_request("GET", "line-level")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_method(snapshots, "calculateSum")[0]

        body = self.log_body(snap)
        captures = body.get("captures", {})
        self.assertIn("lines", captures, f"Expected captures.lines, got: {list(captures.keys())}")

    def test_different_breakpoints_generate_different_snapshots(self) -> None:
        self.send_request("GET", "success")
        self.send_request("GET", "line-level")

        snapshots = self.wait_for_snapshots(min_count=2)

        process_snaps = self.snapshots_for_method(snapshots, "processData")
        calc_snaps = self.snapshots_for_method(snapshots, "calculateSum")

        self.assertGreater(len(process_snaps), 0, "Expected snapshot for processData")
        self.assertGreater(len(calc_snaps), 0, "Expected snapshot for calculateSum")


class DIExpressHitLimitTest(DITestInfrastructure):
    """Test BREAKPOINT hit limit behavior via OTLP.

    With MaxHits=3, exactly 3 snapshots are generated before disabling.
    """

    __test__ = True
    MAX_HITS = 3

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    def test_breakpoint_generates_snapshots_up_to_limit(self) -> None:
        for _ in range(self.MAX_HITS):
            self.send_request("GET", "limited")

        snapshots = self.wait_for_snapshots(min_count=self.MAX_HITS)
        limited_snaps = self.snapshots_for_method(snapshots, "limitedFunction")
        self.assertEqual(
            len(limited_snaps), self.MAX_HITS,
            f"Expected exactly {self.MAX_HITS} snapshots (MaxHits={self.MAX_HITS}), got {len(limited_snaps)}",
        )

    def test_breakpoint_disabled_after_hit_limit(self) -> None:
        for _ in range(self.MAX_HITS):
            self.send_request("GET", "limited")

        snapshots = self.wait_for_snapshots(min_count=self.MAX_HITS)
        initial_count = len(self.snapshots_for_method(snapshots, "limitedFunction"))
        self.assertEqual(initial_count, self.MAX_HITS)

        # Extra calls should NOT generate more snapshots
        for _ in range(3):
            self.send_request("GET", "limited")
        time.sleep(2)

        final_snaps = self._get_di_snapshots()
        final_count = len(self.snapshots_for_method(final_snaps, "limitedFunction"))

        self.assertEqual(
            final_count, self.MAX_HITS,
            f"Expected {self.MAX_HITS} snapshots after limit, got {final_count}",
        )

    def test_limited_snapshot_has_correct_location(self) -> None:
        self.send_request("GET", "limited")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_method(snapshots, "limitedFunction")[0]

        attrs = self.log_attrs(snap)
        self.assertEqual("limitedFunction", attrs.get("aws.di.method_name"))
        self.assertEqual("aabb000000000004", attrs.get("aws.di.location_hash"))


class DIExpressCoexistenceTest(DITestInfrastructure):
    """Test multiple BREAKPOINTs can coexist on different functions via OTLP."""

    __test__ = True

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    def test_shared_function_is_instrumented(self) -> None:
        response = self.send_request("GET", "shared")
        self.assertEqual(200, response.status_code)

        snapshots = self.wait_for_snapshots(min_count=1)
        shared_snaps = self.snapshots_for_method(snapshots, "sharedFunction")
        self.assertGreaterEqual(len(shared_snaps), 1, "Expected snapshot for sharedFunction")

    def test_shared_function_snapshot_has_location_hash(self) -> None:
        self.send_request("GET", "shared")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_method(snapshots, "sharedFunction")[0]

        attrs = self.log_attrs(snap)
        location_hash = attrs.get("aws.di.location_hash")
        self.assertIsNotNone(location_hash, "Snapshot should have location_hash")

    def test_multiple_breakpoints_on_different_functions(self) -> None:
        self.send_request("GET", "success")
        self.send_request("GET", "line-level")
        self.send_request("GET", "shared")

        snapshots = self.wait_for_snapshots(min_count=3)

        process_snaps = self.snapshots_for_method(snapshots, "processData")
        calc_snaps = self.snapshots_for_method(snapshots, "calculateSum")
        shared_snaps = self.snapshots_for_method(snapshots, "sharedFunction")

        self.assertGreater(len(process_snaps), 0, "Expected snapshot for processData")
        self.assertGreater(len(calc_snaps), 0, "Expected snapshot for calculateSum")
        self.assertGreater(len(shared_snaps), 0, "Expected snapshot for sharedFunction")


class DIExpressCaptureLimitsTest(DITestInfrastructure):
    """Tests that DI capture limits are enforced correctly via OTLP.

    Current enforced maximums (from capture-configuration.ts):
        MAX_MAX_STRING_LENGTH = 255
        MAX_MAX_COLLECTION_WIDTH = 20
    """

    __test__ = True
    ENFORCED_MAX_STRING_LENGTH = 255
    ENFORCED_MAX_COLLECTION_WIDTH = 20

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    def test_collection_elements_capped_at_enforced_maximum(self) -> None:
        self.send_request("GET", "limits-collection")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_method(snapshots, "processLargeCollection")[0]

        body = self.log_body(snap)
        captures = body.get("captures", {})
        lines = captures.get("lines", {})
        self.assertGreater(len(lines), 0, "Expected at least one line capture")
        line_capture = list(lines.values())[0]
        locals_captured = line_capture.get("locals", {})

        large_list_val = locals_captured.get("largeList", {})
        self.assertIsNotNone(large_list_val, "Expected 'largeList' local to be captured")

        elements = large_list_val.get("elements", [])
        self.assertIsNotNone(elements, "Captured collection should have 'elements'")
        self.assertLessEqual(
            len(elements),
            self.ENFORCED_MAX_COLLECTION_WIDTH,
            f"Collection should be capped at enforced max {self.ENFORCED_MAX_COLLECTION_WIDTH} elements, "
            f"but had {len(elements)}.",
        )
