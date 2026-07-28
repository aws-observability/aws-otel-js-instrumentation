// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import {
  getAwsRegionFromEnvironment,
  isAgentObservabilityEnabled,
  isAgenticInstrumentationOptIn,
  parseOtelBaggageKeysEnvVar,
  isInstrumentationDisabled,
  detectConflictingInstrumentation,
  getNodeVersion,
  checkDigits,
  isAccountId,
  OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS,
  REDACTED_QUERY_PARAMS,
} from '../src/utils';
// Upstream default list that `redactedQueryParams` REPLACES (does not extend). Imported here so
// the test fails if a dependency bump adds/removes an upstream default we no longer re-include.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEFAULT_QUERY_STRINGS_TO_REDACT } = require('@opentelemetry/instrumentation-http/build/src/internal-types');

describe('Utils', function () {
  beforeEach(() => {
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  it('Test isAgentObservabilityEnabled to be True', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'true';
    expect(isAgentObservabilityEnabled()).toBeTruthy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'True';
    expect(isAgentObservabilityEnabled()).toBeTruthy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'TRUE';
    expect(isAgentObservabilityEnabled()).toBeTruthy();
  });

  it('Test isAgentObservabilityEnabled to be False', () => {
    process.env.AGENT_OBSERVABILITY_ENABLED = 'false';
    expect(isAgentObservabilityEnabled()).toBeFalsy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'False';
    expect(isAgentObservabilityEnabled()).toBeFalsy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'FALSE';
    expect(isAgentObservabilityEnabled()).toBeFalsy();

    process.env.AGENT_OBSERVABILITY_ENABLED = 'anything else';
    expect(isAgentObservabilityEnabled()).toBeFalsy();

    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    expect(isAgentObservabilityEnabled()).toBeFalsy();
  });

  it('Test getAwsRegion from AWS_REGION env var', () => {
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_DEFAULT_REGION = 'eu-west-1';
    expect(getAwsRegionFromEnvironment()).toEqual('us-west-2');
  });

  it('Test getAwsRegion from AWS_DEFAULT_REGION env var', () => {
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = 'eu-west-1';
    expect(getAwsRegionFromEnvironment()).toEqual('eu-west-1');
  });

  it('Test isAgenticInstrumentationOptIn to be True', () => {
    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'true';
    expect(isAgenticInstrumentationOptIn()).toBeTruthy();

    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'True';
    expect(isAgenticInstrumentationOptIn()).toBeTruthy();

    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'TRUE';
    expect(isAgenticInstrumentationOptIn()).toBeTruthy();
  });

  it('Test isAgenticInstrumentationOptIn to be False', () => {
    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'false';
    expect(isAgenticInstrumentationOptIn()).toBeFalsy();

    process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN = 'anything else';
    expect(isAgenticInstrumentationOptIn()).toBeFalsy();

    delete process.env.AWS_AGENTIC_INSTRUMENTATION_OPT_IN;
    expect(isAgenticInstrumentationOptIn()).toBeFalsy();
  });

  it('Test getNodeVersion returns a positive number', () => {
    const version = getNodeVersion();
    expect(version).toBeGreaterThan(0);
  });

  it('Test parseOtelBaggageKeysEnvVar', () => {
    delete process.env[OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS];
    expect(parseOtelBaggageKeysEnvVar().size).toEqual(0);

    process.env[OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS] = 'key1,key2,key3';
    const keys = parseOtelBaggageKeysEnvVar();
    expect(keys.size).toEqual(3);
    expect(keys.has('key1')).toBeTruthy();
    expect(keys.has('key2')).toBeTruthy();
    expect(keys.has('key3')).toBeTruthy();

    process.env[OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS] = ' key1 , key2 ';
    const trimmed = parseOtelBaggageKeysEnvVar();
    expect(trimmed.size).toEqual(2);
    expect(trimmed.has('key1')).toBeTruthy();
    expect(trimmed.has('key2')).toBeTruthy();

    process.env[OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS] = '';
    expect(parseOtelBaggageKeysEnvVar().size).toEqual(0);

    delete process.env[OTEL_BAGGAGE_SPAN_ATTRIBUTE_KEYS];
  });

  it('Test isInstrumentationDisabled with disabled list', () => {
    process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'aws_langchain,aws_openai_agents';
    expect(isInstrumentationDisabled('aws_langchain')).toBeTruthy();
    expect(isInstrumentationDisabled('aws_openai_agents')).toBeTruthy();
    expect(isInstrumentationDisabled('aws_vercel_ai')).toBeFalsy();
    delete process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS;
  });

  it('Test isInstrumentationDisabled with enabled list', () => {
    process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = 'aws_langchain,http';
    expect(isInstrumentationDisabled('aws_langchain')).toBeFalsy();
    expect(isInstrumentationDisabled('aws_openai_agents')).toBeTruthy();
    delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
  });

  it('Test isInstrumentationDisabled with no env vars', () => {
    delete process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS;
    delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
    expect(isInstrumentationDisabled('aws_langchain')).toBeFalsy();
  });

  it('Test detectConflictingInstrumentation returns undefined for unknown shortName', () => {
    expect(detectConflictingInstrumentation('unknown_instrumentation')).toBeUndefined();
  });

  it('Test detectConflictingInstrumentation returns undefined when no conflicts installed', () => {
    expect(detectConflictingInstrumentation('aws_langchain')).toBeUndefined();
  });

  it('Test checkDigits', () => {
    expect(checkDigits('12345')).toBeTruthy();
    expect(checkDigits('0')).toBeTruthy();
    expect(checkDigits('abc')).toBeFalsy();
    expect(checkDigits('123abc')).toBeFalsy();
    expect(checkDigits('')).toBeFalsy();
  });

  it('Test isAccountId', () => {
    expect(isAccountId('123456789012')).toBeTruthy();
    expect(isAccountId('abc')).toBeFalsy();
    expect(isAccountId('')).toBeFalsy();
  });

  describe('REDACTED_QUERY_PARAMS', () => {
    it('re-includes every upstream default (config replaces, does not extend)', () => {
      // The HTTP instrumentation applies redactedQueryParams verbatim in place of its built-in
      // defaults, so omitting any default would silently stop redacting it.
      for (const param of DEFAULT_QUERY_STRINGS_TO_REDACT) {
        expect(REDACTED_QUERY_PARAMS).toContain(param);
      }
    });

    it('adds the AWS SigV4 credential query parameters', () => {
      expect(REDACTED_QUERY_PARAMS).toContain('X-Amz-Signature');
      expect(REDACTED_QUERY_PARAMS).toContain('X-Amz-Credential');
      expect(REDACTED_QUERY_PARAMS).toContain('X-Amz-Security-Token');
    });

    it('does not redact the non-sensitive SigV4 parameters needed for presigned-URL detection', () => {
      // Blanking these would break presigned-URL attribution, which reads them to recognize the
      // request. They must NOT appear in the redaction list.
      expect(REDACTED_QUERY_PARAMS).not.toContain('X-Amz-Algorithm');
      expect(REDACTED_QUERY_PARAMS).not.toContain('X-Amz-Date');
      expect(REDACTED_QUERY_PARAMS).not.toContain('X-Amz-Expires');
      expect(REDACTED_QUERY_PARAMS).not.toContain('X-Amz-SignedHeaders');
    });

    it('contains no duplicate entries', () => {
      expect(new Set(REDACTED_QUERY_PARAMS).size).toBe(REDACTED_QUERY_PARAMS.length);
    });
  });
});
