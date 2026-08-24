// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Mode 1 (zero-code): a plain app with NO OpenTelemetry code. All instrumentation is injected by
// the --require chain (our register patch, then auto-instrumentations-node/register), configured
// entirely through OTEL_* environment variables set by the test runner.
import { runWorkload } from './workload';

void runWorkload();
