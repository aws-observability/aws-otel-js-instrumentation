# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Express sample app contract tests (OTLP-native)."""
from typing import Dict

from typing_extensions import override

from amazon.serviceevents.serviceevents_contract_test_base import (
    ServiceEventsContractTestBase,
    ServiceEventsTestInfrastructure,
)

_APP_IMAGE = "aws-application-signals-tests-serviceevents-express-app"


class ExpressServiceEventsTest(ServiceEventsContractTestBase):
    __test__ = True

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    @override
    def get_application_wait_pattern(self) -> str:
        return "Ready"


class ExpressEndpointFilterTest(ServiceEventsTestInfrastructure):
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
        return {"OTEL_AWS_SERVICE_EVENTS_ENDPOINT_EXCLUDE_PATTERNS": "GET /success"}

    def test_endpoint_exclude_filters_success(self) -> None:
        for _ in range(3):
            self.send_request("GET", "success")
        for _ in range(2):
            self.send_request("GET", "fault")
        records = self.wait_for_log_records("aws.service_events.endpoint_summary")
        routes = {self.log_attrs(r).get("url.route") for r in records}
        self.assertIn("/fault", routes)
        self.assertNotIn("/success", routes)


class ExpressEndpointIncludeTest(ServiceEventsTestInfrastructure):
    """Inverse of ExpressEndpointFilterTest: when an INCLUDE allowlist is set,
    ONLY matching endpoints are tracked. Covers ENDPOINT_INCLUDE_PATTERNS, which
    had no coverage (only the EXCLUDE path was tested)."""

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
        return {"OTEL_AWS_SERVICE_EVENTS_ENDPOINT_INCLUDE_PATTERNS": "GET /success"}

    def test_endpoint_include_allowlist_tracks_only_matching(self) -> None:
        for _ in range(3):
            self.send_request("GET", "success")
        for _ in range(2):
            self.send_request("GET", "fault")
        records = self.wait_for_log_records("aws.service_events.endpoint_summary")
        routes = {self.log_attrs(r).get("url.route") for r in records}
        # Only the allowlisted route produces an EndpointSummary; /fault is filtered out.
        self.assertIn("/success", routes)
        self.assertNotIn("/fault", routes)


class ExpressIncidentCallPathTest(ServiceEventsTestInfrastructure):
    __test__ = True

    @override
    @staticmethod
    def get_application_image_name() -> str:
        return _APP_IMAGE

    @override
    def get_application_wait_pattern(self) -> str:
        return "Ready"

    def test_incident_async_call_path_marked(self) -> None:
        """/async-exception awaits `asyncValidate(null)` → throws. The AST
        registers the helper as is_async=true, so at least one call_path
        entry carries `is_async: true`."""
        self.assertEqual(500, self.send_request("GET", "async-exception").status_code)
        records = self.wait_for_log_records("aws.service_events.incident_snapshot")
        rec = next(
            (r for r in records if (self.log_attrs(r).get("url.route") or "").startswith("/async-exception")),
            None,
        ) or records[0]
        body = self.log_body(rec)
        exc_info = body.get("exception_info") or []
        self.assertTrue(exc_info, "exception_info should be non-empty")
        call_path = exc_info[0].get("call_path") or []
        self.assertTrue(
            any(entry.get("is_async") is True for entry in call_path),
            f"Expected at least one call_path entry with is_async=true; got {call_path!r}",
        )


class ExpressVcsMetadataTest(ServiceEventsTestInfrastructure):
    """Verify VCS + deployment env vars propagate to DeploymentEvent and every
    other signal through `putVcsAndDeploymentAttrs`."""

    __test__ = True

    _EXPECTED_SHA = "e2e-commit-sha-abc123"
    _EXPECTED_REPO = "https://github.com/example/contract-test"
    _EXPECTED_DEPLOYMENT = "contract-dep-42"

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
            "OTEL_AWS_SERVICE_EVENTS_GIT_COMMIT_SHA": self._EXPECTED_SHA,
            "OTEL_AWS_SERVICE_EVENTS_GIT_REPO_URL": self._EXPECTED_REPO,
            "OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_ID": self._EXPECTED_DEPLOYMENT,
        }

    def test_deployment_event_has_vcs_and_deployment_attrs(self) -> None:
        records = self.wait_for_log_records("aws.service_events.deployment_event")
        self.assertGreater(len(records), 0)
        attrs = self.log_attrs(records[0])
        self.assertEqual(attrs.get("vcs.ref.head.revision"), self._EXPECTED_SHA)
        self.assertEqual(attrs.get("vcs.repository.url.full"), self._EXPECTED_REPO)
        self.assertEqual(attrs.get("aws.service_events.deployment.id"), self._EXPECTED_DEPLOYMENT)

    def test_endpoint_summary_propagates_vcs_and_deployment_attrs(self) -> None:
        """putVcsAndDeploymentAttrs runs for every signal, not just DeploymentEvent."""
        self.send_request("GET", "success")
        records = self.wait_for_log_records("aws.service_events.endpoint_summary")
        attrs = self.log_attrs(records[0])
        self.assertEqual(attrs.get("vcs.ref.head.revision"), self._EXPECTED_SHA)
        self.assertEqual(attrs.get("vcs.repository.url.full"), self._EXPECTED_REPO)
        self.assertEqual(attrs.get("aws.service_events.deployment.id"), self._EXPECTED_DEPLOYMENT)


class ExpressAdaptiveSamplingTest(ServiceEventsTestInfrastructure):
    """Verify adaptive sampling actually drops function-call records.

    With TIER1_THRESHOLD=1 and TIER2_THRESHOLD=3, every function past its
    first invocation is subject to tier2 (1-in-TIER2_RATE) or tier3 sampling.
    Driving /success many times guarantees each helper sees enough calls to
    cross the tiers; the emitted FunctionCall record count must be strictly
    less than the raw call count.
    """

    __test__ = True

    _ALWAYS_SERVICE = "express-sampling-always"
    _ADAPTIVE_SERVICE = "express-sampling-adaptive"

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
            "OTEL_AWS_SERVICE_EVENTS_SAMPLING_MODE": "adaptive",
            "OTEL_AWS_SERVICE_EVENTS_FUNCTION_INSTRUMENT_ENABLED": "true",
        }

    @override
    def get_test_config_hook_overrides(self) -> Dict[str, str]:
        # The SAMPLE_TIER* tiers are internal now (no public env var); drive the adaptive
        # sampling cadence through the test-config hook on top of the base flush overrides.
        overrides = super().get_test_config_hook_overrides()
        overrides.update(
            {
                "SAMPLE_TIER1_THRESHOLD": "1",
                "SAMPLE_TIER2_THRESHOLD": "3",
                "SAMPLE_TIER2_RATE": "10",
                "SAMPLE_TIER3_RATE": "100",
            }
        )
        return overrides

    def test_adaptive_sampling_records_fewer_timing_samples_than_calls(self) -> None:
        """Adaptive mode: after a function's first TIER1 call, timing-sampled
        fraction drops (TIER2_RATE then TIER3_RATE).

        FunctionCall telemetry now flows through `service.function.duration`,
        which only counts sampled calls. Total invocation counts aren't
        exposed on this signal, so we assert sampling is happening by
        confirming the histogram count for at least one function is strictly
        less than the request count (20). If sampling were disabled, every
        helper would record once per request and the histogram count would
        match (or exceed) 20.
        """
        for _ in range(20):
            self.send_request("GET", "success")
        data_points = self.wait_for_function_duration_metric(timeout=15.0)
        self.assertGreater(len(data_points), 0, "Expected at least one service.function.duration data point")

        sampling_observed = False
        for dp in data_points:
            attrs = self.dp_attrs(dp)
            # Skip endpoint-handler-shaped functions: they may legitimately
            # appear once per request even with sampling on.
            if attrs.get("status") != "success":
                continue
            if 0 < dp.count < 20:
                sampling_observed = True
                break
        self.assertTrue(
            sampling_observed,
            "Expected at least one service.function.duration data point with 0 < count < 20 "
            "(evidence of adaptive sampling drop).",
        )


class ExpressAppSignalsBundledTest(ServiceEventsTestInfrastructure):
    """Bundled mode: when OTEL_AWS_APPLICATION_SIGNALS_ENABLED=true, EndpointSummary
    is suppressed (App Signals carries equivalent per-endpoint metrics), while
    FunctionCall / IncidentSnapshot / DeploymentEvent continue to flow.
    """

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
        return {"OTEL_AWS_APPLICATION_SIGNALS_ENABLED": "true"}

    def test_endpoint_summary_suppressed_when_app_signals_on(self) -> None:
        import time as _time

        for _ in range(3):
            self.send_request("GET", "success")
        self.send_request("GET", "exception")

        # Wait for other serviceevents signals to confirm the pipeline is alive,
        # then assert EndpointSummary never arrived. FunctionCall telemetry now
        # flows through the histogram metric, not the legacy LogRecord.
        self.wait_for_function_duration_metric()
        _time.sleep(8)

        all_records = self.mock_collector_client.get_logs_now()
        summary_records = [
            r
            for r in all_records
            if self.log_attrs(r).get("event.name") == "aws.service_events.endpoint_summary"
        ]
        self.assertEqual(
            len(summary_records),
            0,
            f"Expected EndpointSummary suppressed under App Signals, got {len(summary_records)}",
        )

        # Other serviceevents log signals still flow.
        for event_name in (
            "aws.service_events.incident_snapshot",
            "aws.service_events.deployment_event",
        ):
            matches = [
                r for r in all_records if self.log_attrs(r).get("event.name") == event_name
            ]
            self.assertGreater(len(matches), 0, f"Expected at least one {event_name}")


class ExpressDisabledTest(ServiceEventsTestInfrastructure):
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
        return {"OTEL_AWS_SERVICE_EVENTS_ENABLED": "false"}

    def test_disabled_produces_no_records(self) -> None:
        import time as _time

        self.send_request("GET", "success")
        self.send_request("GET", "exception")
        # Wait 3x flush interval + buffer for any leftover records
        _time.sleep(8)
        # Should have ZERO ServiceEvents LogRecords
        all_records = self.mock_collector_client.get_logs_now()
        serviceevents_records = [
            r
            for r in all_records
            if self.log_attrs(r).get("event.name", "").startswith("aws.service_events.")
        ]
        self.assertEqual(len(serviceevents_records), 0, f"Expected no serviceevents records, got {len(serviceevents_records)}")

        # The function-duration histogram should also be silent when disabled.
        data_points = self._peek_function_duration_data_points()
        self.assertEqual(
            len(data_points),
            0,
            f"Expected no service.function.duration data points when disabled, found {len(data_points)}",
        )

    @staticmethod
    def log_attrs(record):
        return ServiceEventsTestInfrastructure.log_attrs(record)
