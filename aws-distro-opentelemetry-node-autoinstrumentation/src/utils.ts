// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const AGENT_OBSERVABILITY_ENABLED = 'AGENT_OBSERVABILITY_ENABLED';

// Bypass `readonly` restriction of a Type.
// Workaround provided from official TypeScript docs:
// https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-8.html#improved-control-over-mapped-type-modifiers
export type Mutable<T> = { -readonly [P in keyof T]: T[P] };

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

export const isAgentObservabilityEnabled = () => {
  const agentObservabilityEnabled: string | undefined = process.env[AGENT_OBSERVABILITY_ENABLED];
  if (agentObservabilityEnabled === undefined) {
    return false;
  }

  return agentObservabilityEnabled.toLowerCase() === 'true';
};
