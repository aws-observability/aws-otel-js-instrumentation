// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime environment guards for the profiler.
 *
 * The profiler uses @datadog/pprof, which ships native prebuilt binaries. The
 * Lambda environment requires layer plumbing to include the matching prebuild
 * for the Lambda runtime's Node version/arch. Until that's implemented, hard-
 * gate the profiler off when running on Lambda so we don't crash at require().
 */

/**
 * Returns true if the current process is running inside AWS Lambda.
 * Lambda sets `AWS_LAMBDA_FUNCTION_NAME` on every invocation environment.
 */
export function isRunningInLambda(): boolean {
  return typeof process.env.AWS_LAMBDA_FUNCTION_NAME === 'string' && process.env.AWS_LAMBDA_FUNCTION_NAME.length > 0;
}
