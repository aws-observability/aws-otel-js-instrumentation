// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Instance ID utility for ServiceEvents telemetry.
 *
 * Provides a consistent host identifier that works across different deployment
 * environments (on-premise, containers, VMs, cloud instances).
 */

import * as os from 'os';

// Cache the instance ID to avoid repeated lookups
let cachedInstanceId: string | undefined;

/**
 * Get the host/instance identifier for telemetry.
 *
 * Works across different environments:
 * - Containers: Returns container hostname (usually container ID or pod name)
 * - VMs/EC2: Returns the VM hostname
 * - On-premise: Returns the machine hostname
 *
 * Priority:
 * 1. INSTANCE_ID environment variable (common in cloud environments)
 * 2. HOSTNAME environment variable (set in many container runtimes)
 * 3. os.hostname() (fallback)
 */
export function getInstanceId(): string {
  if (cachedInstanceId !== undefined) {
    return cachedInstanceId;
  }

  // Try environment variables first (allows explicit override)
  let instanceId = process.env.INSTANCE_ID || process.env.HOSTNAME;

  if (!instanceId) {
    // Fall back to os hostname
    try {
      instanceId = os.hostname();
    } catch {
      instanceId = 'unknown';
    }
  }

  // Cache the result
  cachedInstanceId = instanceId;
  return instanceId;
}

/**
 * Clear the cached instance ID (mainly for testing).
 */
export function clearInstanceIdCache(): void {
  cachedInstanceId = undefined;
}
