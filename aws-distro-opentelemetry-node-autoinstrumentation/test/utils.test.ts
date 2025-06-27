// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { getAwsRegionFromEnvironment, isAgentObservabilityEnabled } from '../src/utils';

describe('Utils', function () {
  beforeEach(() => {
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
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

  it('Test getAwsRegion from AWS_REGION env var', () => {
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = 'eu-west-1';
    expect(getAwsRegionFromEnvironment()).toEqual('eu-west-1');
  });
});
