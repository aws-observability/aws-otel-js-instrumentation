// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { diag } from '@opentelemetry/api';

const AGENT_OBSERVABILITY_ENABLED = 'AGENT_OBSERVABILITY_ENABLED';
const AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'AWS_AGENTIC_INSTRUMENTATION_OPT_IN';
export const OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS = 'OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS';

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

export const isAgenticInstrumentationOptIn = (): boolean => {
  const v = process.env[AWS_AGENTIC_INSTRUMENTATION_OPT_IN];
  return v !== undefined && v.toLowerCase() === 'true';
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

export const parseOtelBaggageKeysEnvVar = (): Set<string> => {
  const raw = process.env[OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS] ?? '';
  const keys = new Set<string>();
  for (const k of raw.split(',')) {
    const trimmed = k.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  }
  return keys;
};

export const isInstrumentationDisabled = (shortName: string): boolean => {
  const disabledEnv = process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS;
  if (disabledEnv) {
    const disabled = disabledEnv.split(',').map(s => s.trim());
    if (disabled.includes(shortName)) {
      return true;
    }
  }

  const enabledEnv = process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
  if (enabledEnv) {
    const enabled = enabledEnv.split(',').map(s => s.trim());
    if (!enabled.includes(shortName)) {
      return true;
    }
  }

  return false;
};

const CONFLICTING_INSTRUMENTATIONS: Record<string, string[]> = {
  aws_langchain: [
    '@traceloop/instrumentation-langchain',
    '@arizeai/openinference-instrumentation-langchain',
    '@arizeai/openinference-instrumentation-langchain-v0',
    '@microsoft/agents-a365-observability-extensions-langchain',
    '@langfuse/langchain',
  ],
  aws_openai_agents: [
    '@respan/instrumentation-openai-agents',
    '@microsoft/agents-a365-observability-extensions-openai',
  ],
  aws_vercel_ai: ['@monocle.sh/instrumentation-vercel-ai', '@respan/instrumentation-vercel'],
};

export const detectConflictingInstrumentation = (shortName: string): string | undefined => {
  const conflicts = CONFLICTING_INSTRUMENTATIONS[shortName];
  if (!conflicts) return undefined;

  for (const pkg of conflicts) {
    try {
      require.resolve(pkg);
      return pkg;
    } catch {
      continue;
    }
  }
  return undefined;
};

export const checkDigits = (str: string): boolean => {
  return /^\d+$/.test(str);
};

export const isAccountId = (input: string): boolean => {
  return input != null && checkDigits(input);
};
