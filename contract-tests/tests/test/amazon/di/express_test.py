# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""DI contract tests for Express application via OTLP LogRecord verification.

NOTE: JS DI uses V8 Inspector which only supports line-level breakpoints.
All snapshots have captures.lines (not entry/return at method level).

Validates DI snapshots as OTLP LogRecords with:
  - Flat attributes: aws.di.snapshot_id, aws.di.file_path, aws.di.line_number, aws.di.location_hash, etc.
  - Structured body: captures (lines with locals), stack

Snapshots are matched to their breakpoint by aws.di.line_number (JS DI targets
file path + line only; method_name is not emitted). Line numbers below must stay
in sync with the breakpoint configs in images/applications/di-express/mock_di_api.js.
"""

import time

from typing_extensions import override

from amazon.di.di_contract_test_base import DITestInfrastructure

_APP_IMAGE = "aws-application-signals-tests-di-express-app"

# Breakpoint line numbers from mock_di_api.js (app.js source lines)
_PROCESS_DATA_LINE = 32  # const result = value * 2;
_CALCULATE_SUM_LINE = 52  # const result = a + b;
_LIMITED_FUNCTION_LINE = 60  # return x * 10;
_SHARED_FUNCTION_LINE = 67  # const processed = ...
_LONG_STRING_LINE = 76  # return longString.length;
_LARGE_COLLECTION_LINE = 84  # return largeList.length;
_NESTED_COLLECTION_LINE = 92  # return nested.length;


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

        method_snaps = self.snapshots_for_line(snapshots, _PROCESS_DATA_LINE)
        self.assertGreater(len(method_snaps), 0, "Expected snapshot for processData")

    def test_snapshot_has_required_attributes(self) -> None:
        self.send_request("GET", "success")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _PROCESS_DATA_LINE)[0]

        attrs = self.log_attrs(snap)
        self.assertEqual(attrs.get("event.name"), "aws.dynamic_instrumentation.snapshot")
        self.assertIn("aws.di.snapshot_id", attrs)
        self.assertIn("aws.di.location_hash", attrs)
        self.assertIn("aws.di.instrumentation_level", attrs)
        # method_name is intentionally not emitted (JS DI targets file path + line only)
        self.assertNotIn("aws.di.method_name", attrs)

        # snapshot_id should be UUID format (36 chars)
        snapshot_id = attrs.get("aws.di.snapshot_id", "")
        self.assertEqual(36, len(snapshot_id), f"snapshot_id should be UUID format, got: {snapshot_id}")

    def test_snapshot_has_body_with_captures(self) -> None:
        self.send_request("GET", "success")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _PROCESS_DATA_LINE)[0]

        body = self.log_body(snap)
        self.assertIsNotNone(body, "Body should not be None")
        self.assertIsInstance(body, dict, "Body should be a dict")
        self.assertIn("captures", body, "Body should have captures")

    def test_snapshot_has_correct_location(self) -> None:
        self.send_request("GET", "success")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _PROCESS_DATA_LINE)[0]

        attrs = self.log_attrs(snap)
        self.assertEqual(_PROCESS_DATA_LINE, attrs.get("aws.di.line_number"))
        file_path = attrs.get("aws.di.file_path", "")
        self.assertTrue(file_path.endswith("app.js"), f"file_path should end with app.js, got: {file_path}")

    def test_snapshot_has_location_hash(self) -> None:
        self.send_request("GET", "success")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _PROCESS_DATA_LINE)[0]

        attrs = self.log_attrs(snap)
        self.assertEqual("aabb000000000001", attrs.get("aws.di.location_hash"))

    def test_multiple_requests_generate_multiple_snapshots(self) -> None:
        for _ in range(3):
            self.send_request("GET", "success")

        snapshots = self.wait_for_snapshots(min_count=3)
        method_snaps = self.snapshots_for_line(snapshots, _PROCESS_DATA_LINE)
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
        line_snaps = self.snapshots_for_line(snapshots, _CALCULATE_SUM_LINE)
        self.assertGreater(len(line_snaps), 0, "Expected snapshot for calculateSum")

    def test_line_level_snapshot_has_captures_lines(self) -> None:
        self.send_request("GET", "line-level")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _CALCULATE_SUM_LINE)[0]

        body = self.log_body(snap)
        captures = body.get("captures", {})
        self.assertIn("lines", captures, f"Expected captures.lines, got: {list(captures.keys())}")

    def test_line_level_snapshot_captures_local_values(self) -> None:
        """The /line-level route calls calculateSum(5, 7); the breakpoint sits on
        'const result = a + b' with CaptureLocals: ['a', 'b', 'result'], so the
        arguments a and b must be captured with their actual values."""
        self.send_request("GET", "line-level")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _CALCULATE_SUM_LINE)[0]

        locals_captured = self._line_locals(snap)
        self.assertIn("a", locals_captured, f"Expected local 'a' captured, got: {list(locals_captured.keys())}")
        self.assertIn("b", locals_captured, f"Expected local 'b' captured, got: {list(locals_captured.keys())}")
        self.assertEqual("5", locals_captured["a"].get("value"))
        self.assertEqual("7", locals_captured["b"].get("value"))

    def test_different_breakpoints_generate_different_snapshots(self) -> None:
        self.send_request("GET", "success")
        self.send_request("GET", "line-level")

        snapshots = self.wait_for_snapshots(min_count=2)

        process_snaps = self.snapshots_for_line(snapshots, _PROCESS_DATA_LINE)
        calc_snaps = self.snapshots_for_line(snapshots, _CALCULATE_SUM_LINE)

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
        limited_snaps = self.snapshots_for_line(snapshots, _LIMITED_FUNCTION_LINE)
        self.assertEqual(
            len(limited_snaps), self.MAX_HITS,
            f"Expected exactly {self.MAX_HITS} snapshots (MaxHits={self.MAX_HITS}), got {len(limited_snaps)}",
        )

    def test_breakpoint_disabled_after_hit_limit(self) -> None:
        for _ in range(self.MAX_HITS):
            self.send_request("GET", "limited")

        snapshots = self.wait_for_snapshots(min_count=self.MAX_HITS)
        initial_count = len(self.snapshots_for_line(snapshots, _LIMITED_FUNCTION_LINE))
        self.assertEqual(initial_count, self.MAX_HITS)

        # Extra calls should NOT generate more snapshots
        for _ in range(3):
            self.send_request("GET", "limited")
        time.sleep(2)

        final_snaps = self._get_di_snapshots()
        final_count = len(self.snapshots_for_line(final_snaps, _LIMITED_FUNCTION_LINE))

        self.assertEqual(
            final_count, self.MAX_HITS,
            f"Expected {self.MAX_HITS} snapshots after limit, got {final_count}",
        )

    def test_limited_snapshot_has_correct_location(self) -> None:
        self.send_request("GET", "limited")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _LIMITED_FUNCTION_LINE)[0]

        attrs = self.log_attrs(snap)
        self.assertEqual(_LIMITED_FUNCTION_LINE, attrs.get("aws.di.line_number"))
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
        shared_snaps = self.snapshots_for_line(snapshots, _SHARED_FUNCTION_LINE)
        self.assertGreaterEqual(len(shared_snaps), 1, "Expected snapshot for sharedFunction")

    def test_shared_function_snapshot_has_location_hash(self) -> None:
        self.send_request("GET", "shared")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _SHARED_FUNCTION_LINE)[0]

        attrs = self.log_attrs(snap)
        location_hash = attrs.get("aws.di.location_hash")
        self.assertIsNotNone(location_hash, "Snapshot should have location_hash")

    def test_multiple_breakpoints_on_different_functions(self) -> None:
        self.send_request("GET", "success")
        self.send_request("GET", "line-level")
        self.send_request("GET", "shared")

        snapshots = self.wait_for_snapshots(min_count=3)

        process_snaps = self.snapshots_for_line(snapshots, _PROCESS_DATA_LINE)
        calc_snaps = self.snapshots_for_line(snapshots, _CALCULATE_SUM_LINE)
        shared_snaps = self.snapshots_for_line(snapshots, _SHARED_FUNCTION_LINE)

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
        """The /limits-collection route passes a 50-element array; the config requests
        MaxCollectionWidth=9999 which is clamped to 20, so exactly 20 elements are
        captured and the value is marked truncated."""
        self.send_request("GET", "limits-collection")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _LARGE_COLLECTION_LINE)[0]

        locals_captured = self._line_locals(snap)
        self.assertIn(
            "largeList", locals_captured,
            f"Expected 'largeList' local to be captured, got: {list(locals_captured.keys())}",
        )
        large_list_val = locals_captured["largeList"]

        elements = large_list_val.get("elements")
        self.assertIsNotNone(elements, "Captured collection should have 'elements'")
        self.assertEqual(
            len(elements),
            self.ENFORCED_MAX_COLLECTION_WIDTH,
            f"Collection should be capped at enforced max {self.ENFORCED_MAX_COLLECTION_WIDTH} elements, "
            f"but had {len(elements)}.",
        )
        self.assertTrue(large_list_val.get("truncated"), "Capped collection should be marked truncated")
        self.assertEqual(50, large_list_val.get("size"), "Captured size should be the original element count")
        self.assertEqual("1", elements[0].get("value"), "First element should be captured with its value")

    def test_string_truncated_at_enforced_maximum(self) -> None:
        """The /limits-string route passes a 500-char string; the config requests
        MaxStringLength=9999 which is clamped to 255, so the captured value is
        exactly 255 chars and marked truncated."""
        self.send_request("GET", "limits-string")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _LONG_STRING_LINE)[0]

        locals_captured = self._line_locals(snap)
        self.assertIn(
            "longString", locals_captured,
            f"Expected 'longString' local to be captured, got: {list(locals_captured.keys())}",
        )
        long_string_val = locals_captured["longString"]

        captured = long_string_val.get("value")
        self.assertIsNotNone(captured, "Captured string should have 'value'")
        self.assertEqual(
            len(captured),
            self.ENFORCED_MAX_STRING_LENGTH,
            f"String should be truncated to enforced max {self.ENFORCED_MAX_STRING_LENGTH} chars, "
            f"but had {len(captured)}.",
        )
        self.assertTrue(long_string_val.get("truncated"), "Truncated string should be marked truncated")
        self.assertEqual(500, long_string_val.get("size"), "Captured size should be the original string length")

    def test_collection_depth_capped_at_configured_maximum(self) -> None:
        """The /limits-collection-depth route passes [[[['deep']]]]; the config sets
        MaxCollectionDepth=1, so the root array is captured but its nested array
        element is cut with not_captured_reason=depth."""
        self.send_request("GET", "limits-collection-depth")
        snapshots = self.wait_for_snapshots(min_count=1)
        snap = self.snapshots_for_line(snapshots, _NESTED_COLLECTION_LINE)[0]

        locals_captured = self._line_locals(snap)
        self.assertIn(
            "nested", locals_captured,
            f"Expected 'nested' local to be captured, got: {list(locals_captured.keys())}",
        )
        nested_val = locals_captured["nested"]

        self.assertEqual("Array", nested_val.get("type"))
        elements = nested_val.get("elements")
        self.assertIsNotNone(elements, "Root array should be captured with 'elements'")
        self.assertEqual(1, len(elements))
        self.assertEqual(
            "depth",
            elements[0].get("not_captured_reason"),
            f"Nested array beyond MaxCollectionDepth=1 should be cut with reason 'depth', got: {elements[0]}",
        )
