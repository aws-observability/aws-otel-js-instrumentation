// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ServiceEventsMonitorState } from '../serviceevents-monitor';

/**
 * Extract the primary error type + origin function from the monitor's investigation data.
 *
 * Reads (PEEKS — does not clear) the per-request investigation data the AST monitor accumulates,
 * so the data remains available for the incident snapshot collector. Returns undefined when no
 * error type was captured — neither a passed-in exception nor a monitor-recorded one — so the
 * caller omits the error breakdown entirely, matching Java (whose gate is
 * `statusCode >= 500 && errorType != null`). A 5xx with no captured exception (e.g. a handler that
 * returns a 500 status without throwing) must NOT synthesize an "UnknownError" breakdown entry.
 */
export function extractErrorFromCallPath(
  exception: Error | null
): { errorType: string; functionName: string } | undefined {
  const invData = ServiceEventsMonitorState.getInstance().peekInvestigationData();

  // Resolve the error type. Prefer the passed-in exception; otherwise recover the type the monitor
  // captured (a global error handler may have converted the error to a 5xx response before it
  // reached any instrumented frame, leaving `exception` null even though a real error occurred).
  let errorType: string | undefined;
  if (exception?.constructor?.name) {
    errorType = exception.constructor.name;
  } else if (invData?.exception?.name) {
    errorType = invData.exception.name;
  }
  if (errorType === undefined) {
    return undefined;
  }

  // Find the origin function. Prefer the function the monitor recorded as the actual thrower;
  // fall back to the innermost call_path frame.
  let functionName = 'unknown';
  if (invData?.exception?.functionName) {
    functionName = invData.exception.functionName;
  } else if (invData?.callPath && invData.callPath.length > 0) {
    functionName = invData.callPath[0].functionName ?? 'unknown';
  }

  return { errorType, functionName };
}
