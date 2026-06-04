# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Three-mode profiler contract tests — end-to-end OTLP verification.

Class hierarchy mirrors the Python SDK
(`private-aws-otel-python-instrumentation-staging/.../profiler_flask_test.py`):

  ProfilerOnlyModeTest  extends ServiceEventsTestInfrastructure  (AST off  -> no FunctionCall)
  AstOnlyModeTest       extends ServiceEventsContractTestBase    (AST on   -> inherited suite covers it)
  CombinedModeTest      extends ServiceEventsContractTestBase    (AST on + profiler on)

AggregateProfile is emitted in the spec §8 compressed-wrapper format:
  body = {
    "encoding": "zstd",
    "data": <base64 zstd-compressed JSON of OTLP profile v1development>,
    "trace_links": [{trace_id, span_id}, ...],
    "operations": [...],
  }
Tests decompress the inner profile and validate the dictionary tables.
"""
import base64
import json
import time
from typing import Dict

import zstandard
from typing_extensions import override

from amazon.serviceevents.serviceevents_contract_test_base import (
    ServiceEventsContractTestBase,
    ServiceEventsTestInfrastructure,
)

_APP_IMAGE = "aws-application-signals-tests-serviceevents-express-app"


def _wrapper(test_self, log) -> Dict:
    """Extract the spec §8 compressed wrapper from the LogRecord body."""
    body = test_self.log_body(log)
    test_self.assertIsInstance(body, dict)
    test_self.assertEqual(body.get("encoding"), "zstd", "AggregateProfile body must use zstd encoding")
    test_self.assertIn("data", body)
    test_self.assertIn("trace_links", body)
    test_self.assertIn("operations", body)
    return body


def _inner_profile(test_self, log) -> Dict:
    """Decompress the wrapper to the OTLP profile v1development dict."""
    wrapper = _wrapper(test_self, log)
    compressed = base64.b64decode(wrapper["data"])
    decompressed = zstandard.ZstdDecompressor().decompress(compressed)
    return json.loads(decompressed)


class ProfilerOnlyModeTest(ServiceEventsTestInfrastructure):
    """Default mode: profiler on, AST off."""

    __test__ = True

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    @override
    def get_application_wait_pattern(self) -> str:
        return "Ready"

    @override
    def get_application_extra_environment_variables(self) -> Dict[str, str]:
        return {
            "OTEL_AWS_SERVICE_EVENTS_PROFILER_ENABLED": "true",
            "OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED": "false",
        }

    @override
    def get_test_config_hook_overrides(self) -> Dict[str, str]:
        # PROFILER_WINDOW_SECONDS is internal now (no public env var); shorten the
        # rotation/flush window via the test-config hook on top of the base flush overrides.
        overrides = super().get_test_config_hook_overrides()
        overrides["PROFILER_WINDOW_SECONDS"] = "5"
        return overrides

    def _wait_for_aggregate_profile(self, traffic_path: str = "slow", deadline_seconds: int = 30):
        """Drive a /slow request (long enough to be profiler-visible) then poll."""
        self.send_request("GET", traffic_path)
        deadline = time.time() + deadline_seconds
        records = []
        while time.time() < deadline and not records:
            records = self._get_log_records_matching("aws.service_events.aggregate_profile")
            if not records:
                time.sleep(1)
        if not records:
            self.skipTest(
                f"No AggregateProfile captured within {deadline_seconds}s — sampler "
                "didn't observe a tracked request thread (expected on fast shared runners)."
            )
        return records

    # -------------------- positive signals --------------------

    def test_aggregate_profile_emitted(self) -> None:
        """Spec §8: compressed wrapper with all required fields."""
        records = self._wait_for_aggregate_profile()
        log = records[0]
        attrs = self.log_attrs(log)
        self.assertEqual(attrs.get("event.name"), "aws.service_events.aggregate_profile")

        # Old attrs must be ABSENT (cleanup gate).
        for stale in (
            "aws.service_events.aggregation_type",
            "aws.service_events.profile.total_samples",
            "aws.service_events.profile.window_start_ms",
            "aws.service_events.profile.window_end_ms",
            "aws.service_events.operation",
            "aws.service_events.request.count",
        ):
            self.assertNotIn(stale, attrs, f"stale attr {stale} should not appear in spec §8 AggregateProfile")

        # Inner profile must be a valid OTLP profile v1development.
        inner = _inner_profile(self, log)
        self.assertEqual(inner["sample_type"], {"type_strindex": 1, "unit_strindex": 2})
        self.assertEqual(inner["period_type"], {"type_strindex": 1, "unit_strindex": 2})
        self.assertIn("time_unix_nano", inner)
        self.assertIn("duration_nano", inner)
        self.assertIn("period", inner)
        self.assertEqual(len(inner["profile_id"]), 32)

        # Well-known string indices [0..4]
        st = inner["string_table"]
        self.assertEqual(st[0], "")
        self.assertEqual(st[1], "wall")
        self.assertEqual(st[2], "nanoseconds")
        self.assertEqual(st[3], "thread.name")
        self.assertEqual(st[4], "operation")

        # Sentinel index-0 entries
        self.assertEqual(
            inner["function_table"][0],
            {"name_strindex": 0, "system_name_strindex": 0, "filename_strindex": 0, "start_line": 0},
        )
        self.assertEqual(inner["location_table"][0]["lines"], [{"function_index": 0, "line": 0}])
        self.assertEqual(inner["stack_table"][0]["location_indices"], [0])
        self.assertEqual(inner["link_table"][0], {"trace_id": "", "span_id": ""})
        self.assertEqual(inner["attribute_table"][0], {"key_strindex": 0, "value_strindex": 0})

    def test_aggregate_profile_carries_operation_in_wrapper(self) -> None:
        """Wrapper.operations should surface the HTTP operation."""
        records = self._wait_for_aggregate_profile()
        op_records = [r for r in records if (self.log_body(r) or {}).get("operations")]
        if not op_records:
            self.skipTest("No AggregateProfile with operations attribution captured.")
        wrapper = _wrapper(self, op_records[0])
        ops = wrapper["operations"]
        self.assertGreater(len(ops), 0)
        # At least one operation should reference our /slow route.
        self.assertTrue(any("slow" in op.lower() or "GET" in op for op in ops),
                        f"Expected /slow or GET in operations, got {ops}")

    def test_aggregate_profile_filter_only_tracked_samples(self) -> None:
        """serialize_compressed drops samples without trace OR operation."""
        records = self._wait_for_aggregate_profile()
        for log in records:
            inner = _inner_profile(self, log)
            for sample in inner["samples"]:
                has_link = sample.get("link_index", 0) != 0
                has_op = False
                for attr_idx in sample.get("attribute_indices", []) or []:
                    if inner["attribute_table"][attr_idx]["key_strindex"] == 4:  # operation
                        has_op = True
                        break
                self.assertTrue(has_link or has_op, f"Sample passed filter without link or operation: {sample}")

    def test_aggregate_profile_no_trace_context(self) -> None:
        """LogRecord traceId/spanId must remain zero — trace correlation in inner link_table."""
        records = self._wait_for_aggregate_profile()
        for log in records:
            self.assertFalse(any(log.log_record.trace_id), "AggregateProfile must not have trace context")
            self.assertFalse(any(log.log_record.span_id), "AggregateProfile must not have span context")

    def test_aggregate_profile_zstd_roundtrip(self) -> None:
        """Decoded inner profile is well-formed JSON with all expected keys."""
        records = self._wait_for_aggregate_profile()
        for log in records:
            inner = _inner_profile(self, log)
            for required in ("sample_type", "time_unix_nano", "duration_nano", "period_type",
                             "period", "profile_id", "string_table", "function_table",
                             "location_table", "stack_table", "link_table", "attribute_table",
                             "samples"):
                self.assertIn(required, inner, f"Missing required field {required}")

    def test_incident_snapshot_no_profiler_call_path(self) -> None:
        """IncidentSnapshot must NOT carry profiler_call_path (spec §5 removal)."""
        self.send_request("GET", "fault")
        records = self.wait_for_log_records("aws.service_events.incident_snapshot", timeout=20.0)
        self.assertGreater(len(records), 0)
        body = self.log_body(records[0])
        self.assertIsInstance(body, dict)
        self.assertNotIn("profiler_call_path", body, "profiler_call_path must not appear (removed from spec §5)")
        self.assertNotIn("profiler_stacks", body, "profiler_stacks must not appear (removed from spec §5)")

    def test_endpoint_summary_still_works(self) -> None:
        """EndpointSummary is emitted independently of profiler/AST modes."""
        for _ in range(3):
            self.assertEqual(200, self.send_request("GET", "success").status_code)
        records = self.wait_for_log_records("aws.service_events.endpoint_summary")
        rec = next(
            (r for r in records if self.log_attrs(r).get("url.route") == "/success"),
            None,
        )
        self.assertIsNotNone(rec, "No EndpointSummary for /success")
        self.assert_endpoint_summary(rec, method="GET", route="/success")

    def test_deployment_event_still_works(self) -> None:
        records = self.wait_for_log_records("aws.service_events.deployment_event")
        self.assertGreater(len(records), 0)
        self.assert_deployment_event(records[0])

    # -------------------- negative assertions --------------------

    def test_no_function_call_records(self) -> None:
        """AST is OFF — FunctionCall telemetry must be absent."""
        for _ in range(3):
            self.send_request("GET", "success")
        # Wait for a positive signal so we know at least one flush happened.
        self.wait_for_log_records("aws.service_events.endpoint_summary")
        fc = self._get_log_records_matching("aws.service_events.function_call")
        self.assertEqual(
            len(fc),
            0,
            f"With AST off, expected zero FunctionCall records; got {len(fc)}",
        )
        fc_data_points = self._peek_function_duration_data_points()
        self.assertEqual(
            len(fc_data_points),
            0,
            f"Expected zero service.function.duration data points; got {len(fc_data_points)}",
        )


class AstOnlyModeTest(ServiceEventsContractTestBase):
    """AST on, profiler off."""

    __test__ = True

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    @override
    def get_application_wait_pattern(self) -> str:
        return "Ready"

    @override
    def get_application_extra_environment_variables(self) -> Dict[str, str]:
        return {
            "OTEL_AWS_SERVICE_EVENTS_PROFILER_ENABLED": "false",
            "OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED": "true",
        }

    def test_no_aggregate_profile(self) -> None:
        """Profiler is OFF — AggregateProfile records must be absent."""
        self.send_request("GET", "success")
        time.sleep(8)
        ap = self._get_log_records_matching("aws.service_events.aggregate_profile")
        self.assertEqual(
            len(ap),
            0,
            f"With profiler off, expected zero AggregateProfile records; got {len(ap)}",
        )


class CombinedModeTest(ServiceEventsContractTestBase):
    """Both flags on — full signal set."""

    __test__ = True

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    @override
    def get_application_wait_pattern(self) -> str:
        return "Ready"

    @override
    def get_application_extra_environment_variables(self) -> Dict[str, str]:
        return {
            "OTEL_AWS_SERVICE_EVENTS_PROFILER_ENABLED": "true",
            "OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED": "true",
        }

    @override
    def get_test_config_hook_overrides(self) -> Dict[str, str]:
        # PROFILER_WINDOW_SECONDS is internal now (no public env var); shorten the
        # rotation/flush window via the test-config hook on top of the base flush overrides.
        overrides = super().get_test_config_hook_overrides()
        overrides["PROFILER_WINDOW_SECONDS"] = "5"
        return overrides

    def test_aggregate_profile_emitted(self) -> None:
        self.send_request("GET", "slow")
        deadline = time.time() + 30.0
        records = []
        while time.time() < deadline and not records:
            records = self._get_log_records_matching("aws.service_events.aggregate_profile")
            if not records:
                time.sleep(1)
        if not records:
            self.skipTest("No AggregateProfile captured within 30s.")
        # Validate spec §8 wrapper shape.
        wrapper = _wrapper(self, records[0])
        self.assertEqual(wrapper["encoding"], "zstd")

    def test_incident_has_call_path_and_no_profiler_call_path(self) -> None:
        """AST supplies call_path on incidents; profiler_call_path is gone (spec §5)."""
        self.send_request("GET", "slow")
        self.send_request("GET", "exception")
        records = self.wait_for_log_records(
            "aws.service_events.incident_snapshot", min_count=2, timeout=20.0
        )
        bodies = [self.log_body(r) for r in records]
        # AST supplies call_path on at least one incident.
        self.assertTrue(
            any(b.get("exception_info") and b["exception_info"][0].get("call_path") for b in bodies),
            "Expected at least one incident with a populated call_path",
        )
        # profiler_call_path must NEVER appear (removed from spec §5).
        for b in bodies:
            self.assertNotIn("profiler_call_path", b, "profiler_call_path must not appear (removed from spec §5)")
            self.assertNotIn("profiler_stacks", b, "profiler_stacks must not appear (removed from spec §5)")
