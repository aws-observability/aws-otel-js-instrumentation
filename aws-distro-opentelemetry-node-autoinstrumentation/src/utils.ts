// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';

export const getNodeVersion = () => {
  const nodeVersion = process.versions.node;
  const versionParts = nodeVersion.split('.');

  if (versionParts.length === 0) {
    return -1;
  }

  const majorVersion = parseInt(versionParts[0], 10);

  if (isNaN(majorVersion)) {
    return -1;
  }

  return majorVersion;
};

/**
 * Get AWS region from environment or boto3 session.
 * Returns the AWS region in the following priority order:
 * 1. AWS_REGION environment variable
 * 2. AWS_DEFAULT_REGION environment variable
 * 3. undefined if no region can be determined
 */
export const getAwsRegionFromEnvironment = (): string | undefined => {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region) {
    return region;
  }

  diag.warn(
    'AWS region not found in environment variables (AWS_REGION, AWS_DEFAULT_REGION). Please set AWS_REGION environment variable explicitly.'
  );

  return undefined;
};
