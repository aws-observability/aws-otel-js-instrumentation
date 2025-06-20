// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { isAgentObservabilityEnabled } from '../src/utils';

describe('Utils', function () {
  beforeEach(() => {
    delete process.env.AGENT_OBSERVABILITY_ENABLED;
    delete process.env.AWS_REGION;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
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
});
