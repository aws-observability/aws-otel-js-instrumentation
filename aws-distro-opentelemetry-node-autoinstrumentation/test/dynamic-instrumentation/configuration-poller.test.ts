// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import { diag } from '@opentelemetry/api';
import { ConfigurationPoller } from '../../src/dynamic-instrumentation/configuration-poller';
import { DynamicInstrumentationClient } from '../../src/dynamic-instrumentation/client';
import { DynamicInstrumentationConfig } from '../../src/dynamic-instrumentation/config';
import { ListConfigurationsResponse } from '../../src/dynamic-instrumentation/model/api-response';
import { InstrumentationConfiguration } from '../../src/dynamic-instrumentation/model/instrumentation-configuration';

/**
 * Build a minimal DynamicInstrumentationConfig for testing attribute filters.
 *
 * resourceAttributes mirrors what the main thread would resolve from the SDK
 * Resource: service.name, deployment.environment(.name), and detector-contributed
 * attributes such as instance.id / cloud.region.
 */
function makeConfig(overrides: Partial<DynamicInstrumentationConfig> = {}): DynamicInstrumentationConfig {
  return {
    enabled: true,
    apiUrl: 'http://localhost:2000',
    probePollIntervalSeconds: 600,
    breakpointPollIntervalSeconds: 60,
    outputDirectory: 'aws-di-snapshots',
    logsEndpoint: 'http://localhost:4316/v1/logs',
    serviceName: 'order-service',
    environment: 'production',
    namespace: '',
    resourceAttributes: {
      'service.name': 'order-service',
      'deployment.environment.name': 'production',
      'deployment.environment': 'production',
      'instance.id': 'i-abc123',
      'cloud.region': 'us-west-2',
    },
    ...overrides,
  };
}

/**
 * Build a minimal valid BREAKPOINT API config item for filter testing.
 */
function makeApiConfigItem(attributeFilters: Array<Record<string, string>> | undefined): Record<string, unknown> {
  return {
    InstrumentationType: 'BREAKPOINT',
    SignalType: 'SNAPSHOT',
    Location: {
      CodeLocation: {
        Language: 'javascript',
        MethodName: 'processOrder',
        FilePath: 'src/services/orderService.js',
        LineNumber: 42,
      },
    },
    LocationHash: 'hash123',
    ExpiresAt: '2099-12-31T23:59:59Z',
    CaptureConfiguration: { CodeCapture: { CaptureLimits: {} } },
    ...(attributeFilters !== undefined ? { AttributeFilters: attributeFilters } : {}),
  };
}

/**
 * Build a ListConfigurationsResponse containing one config with the given filters.
 */
function makeResponse(attributeFilters: Array<Record<string, string>> | undefined): ListConfigurationsResponse {
  return {
    Changed: true,
    SyncedAt: 1000,
    SyncInterval: 60,
    LatestConfigurations: [makeApiConfigItem(attributeFilters)],
    NextToken: null,
  };
}

/**
 * Create a ConfigurationPoller instance for testing.
 * We use a dummy client (never called in these tests) and access private methods via `as any`.
 */
function createPoller(config?: DynamicInstrumentationConfig): ConfigurationPoller {
  const client = {} as DynamicInstrumentationClient;
  const callbacks = {
    onProbeBreakpointConfigs: () => {},
  };
  return new ConfigurationPoller(client, config ?? makeConfig(), callbacks);
}

describe('ConfigurationPoller attribute filter matching', function () {
  // Resource attributes are supplied via config.resourceAttributes (resolved from
  // the SDK Resource on the main thread), not from OTEL_RESOURCE_ATTRIBUTES.

  // --- No filters ---

  it('should include config when AttributeFilters is empty array', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([]);
    expect(result).toBe(true);
  });

  it('should include config when AttributeFilters is undefined', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters(undefined);
    expect(result).toBe(true);
  });

  it('should include config when AttributeFilters is null', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters(null);
    expect(result).toBe(true);
  });

  // --- Single filter, single key (basic match/no-match) ---

  it('should include config when single filter matches service.name', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([{ 'service.name': 'order-service' }]);
    expect(result).toBe(true);
  });

  it('should exclude config when single filter does not match service.name', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([{ 'service.name': 'payment-service' }]);
    expect(result).toBe(false);
  });

  // --- Single filter, multiple keys (AND within) ---

  it('should include config when all keys in single filter match', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([
      { 'service.name': 'order-service', 'deployment.environment.name': 'production' },
    ]);
    expect(result).toBe(true);
  });

  it('should exclude config when one key in single filter does not match', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([
      { 'service.name': 'order-service', 'deployment.environment.name': 'staging' },
    ]);
    expect(result).toBe(false);
  });

  // --- Multiple filters (OR across) — THIS IS THE BUG FIX ---

  it('should include config when first filter matches but second does not', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([
      { 'service.name': 'order-service' }, // matches
      { 'service.name': 'payment-service' }, // does not match
    ]);
    expect(result).toBe(true);
  });

  it('should include config when second filter matches but first does not', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([
      { 'service.name': 'payment-service' }, // does not match
      { 'service.name': 'order-service' }, // matches
    ]);
    expect(result).toBe(true);
  });

  it('should exclude config when no filter objects match', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([
      { 'service.name': 'payment-service' }, // does not match
      { 'service.name': 'inventory-service' }, // does not match
    ]);
    expect(result).toBe(false);
  });

  // --- Complex scenario ---

  it('should include config when first multi-key filter matches via resource attributes', function () {
    // First filter: instance.id=i-abc123 AND cloud.region=us-west-2 — both from resourceAttributes
    // Second filter: service.name=payment-service — does NOT match
    // Result: config IS included (OR — first filter matched)
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([
      { 'instance.id': 'i-abc123', 'cloud.region': 'us-west-2' },
      { 'service.name': 'payment-service' },
    ]);
    expect(result).toBe(true);
  });

  it('should exclude config when partial matches exist across filters but no single filter fully matches', function () {
    // Filter 1: instance.id=i-abc123 AND cloud.region=eu-west-1 — region wrong
    // Filter 2: service.name=payment-service — service wrong
    // Result: config is EXCLUDED
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([
      { 'instance.id': 'i-abc123', 'cloud.region': 'eu-west-1' },
      { 'service.name': 'payment-service' },
    ]);
    expect(result).toBe(false);
  });

  // --- Edge cases ---

  it('should include config when filter object is empty {} (vacuously true)', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([{}]);
    expect(result).toBe(true);
  });

  it('should handle deployment.environment.name as alias for environment', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([{ 'deployment.environment.name': 'production' }]);
    expect(result).toBe(true);
  });

  it('should handle deployment.environment as alias for environment', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([{ 'deployment.environment': 'production' }]);
    expect(result).toBe(true);
  });

  it('should match detector-contributed attributes from the resource', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([{ 'instance.id': 'i-abc123' }]);
    expect(result).toBe(true);
  });

  it('should not match attributes absent from the resource (fails closed)', function () {
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([{ 'custom.attr': 'value' }]);
    expect(result).toBe(false);
  });

  it('should fail open (allow config) when filter evaluation throws', function () {
    // A filter whose value is a non-string causes Object.entries iteration to be fine,
    // but force an error by passing a filter object whose entries throw on access.
    const poller = createPoller();
    const throwingFilter: Record<string, string> = {};
    Object.defineProperty(throwingFilter, 'service.name', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const result = (poller as any).matchesAttributeFilters([throwingFilter]);
    expect(result).toBe(true);
  });

  // --- Integration test through parseProbeBreakpointConfigs ---

  it('should filter configs via parseProbeBreakpointConfigs with OR-across logic', function () {
    const poller = createPoller();
    const response: ListConfigurationsResponse = {
      Changed: true,
      SyncedAt: 1000,
      SyncInterval: 60,
      LatestConfigurations: [
        // Config 1: matching filter (service.name=order-service)
        makeApiConfigItem([{ 'service.name': 'order-service' }]),
        // Config 2: non-matching filter (service.name=payment-service)
        {
          ...makeApiConfigItem([{ 'service.name': 'payment-service' }]),
          LocationHash: 'hash456',
        },
        // Config 3: OR-across — second filter matches
        {
          ...makeApiConfigItem([{ 'service.name': 'payment-service' }, { 'instance.id': 'i-abc123' }]),
          LocationHash: 'hash789',
        },
      ],
      NextToken: null,
    };

    const configs = (poller as any).parseProbeBreakpointConfigs(response);
    // Config 1 matches, Config 2 excluded, Config 3 matches (second filter)
    expect(configs.length).toBe(2);
    expect(configs[0].locationHash).toBe('hash123');
    expect(configs[1].locationHash).toBe('hash789');
  });

  it('should include config with no AttributeFilters field via parseProbeBreakpointConfigs', function () {
    const poller = createPoller();
    const response = makeResponse(undefined);
    const configs = (poller as any).parseProbeBreakpointConfigs(response);
    expect(configs.length).toBe(1);
  });

  it('should include config with empty AttributeFilters via parseProbeBreakpointConfigs', function () {
    const poller = createPoller();
    const response = makeResponse([]);
    const configs = (poller as any).parseProbeBreakpointConfigs(response);
    expect(configs.length).toBe(1);
  });

  it('should exclude config with non-matching filters via parseProbeBreakpointConfigs', function () {
    const poller = createPoller();
    const response = makeResponse([{ 'service.name': 'wrong-service' }]);
    const configs = (poller as any).parseProbeBreakpointConfigs(response);
    expect(configs.length).toBe(0);
  });

  // --- OR-across regression: verify old AND-across behavior would have failed ---

  it('should include config when only one of multiple filters matches (regression test)', function () {
    // Under the old AND-across logic, this would fail because the first filter doesn't match.
    // Under the correct OR-across logic, the second filter matching is sufficient.
    const poller = createPoller();
    const result = (poller as any).matchesAttributeFilters([
      { 'cloud.region': 'eu-central-1' }, // does not match (actual is us-west-2)
      { 'cloud.region': 'us-west-2' }, // matches
    ]);
    expect(result).toBe(true);
  });
});

describe('ConfigurationPoller polling loop', function () {
  let clock: sinon.SinonFakeTimers;
  let client: sinon.SinonStubbedInstance<DynamicInstrumentationClient>;
  let received: InstrumentationConfiguration[][];
  let poller: ConfigurationPoller;

  function buildResponse(changed: boolean, configs: Array<Record<string, unknown>> = []): ListConfigurationsResponse {
    return {
      Changed: changed,
      SyncedAt: 1000,
      SyncInterval: 60,
      LatestConfigurations: configs,
      NextToken: null,
    };
  }

  beforeEach(function () {
    clock = sinon.useFakeTimers();
    client = sinon.createStubInstance(DynamicInstrumentationClient);
    received = [];
    poller = new ConfigurationPoller(client, makeConfig(), {
      onProbeBreakpointConfigs: configs => received.push(configs),
    });
  });

  afterEach(function () {
    poller.stop();
    clock.restore();
    sinon.restore();
  });

  it('fetches BREAKPOINT configurations on start and forwards parsed configs when Changed', async function () {
    client.fetchConfigurations.resolves(buildResponse(true, [makeApiConfigItem(undefined)]));

    poller.start();
    await clock.tickAsync(0);

    expect(client.fetchConfigurations.called).toBe(true);
    expect(received.length).toBe(1);
    expect(received[0].length).toBe(1);
  });

  it('does not forward configs when the response is unchanged', async function () {
    client.fetchConfigurations.resolves(buildResponse(false));

    poller.start();
    await clock.tickAsync(0);

    expect(client.fetchConfigurations.called).toBe(true);
    expect(received.length).toBe(0);
  });

  it('is idempotent — calling start() twice only starts one loop', async function () {
    client.fetchConfigurations.resolves(buildResponse(false));

    poller.start();
    poller.start();
    await clock.tickAsync(0);

    expect(client.fetchConfigurations.callCount).toBe(1);
  });

  it('schedules the next poll after the configured interval', async function () {
    client.fetchConfigurations.resolves(buildResponse(false));

    poller.start();
    await clock.tickAsync(0);
    const afterFirst = client.fetchConfigurations.callCount;

    // breakpointPollIntervalSeconds = 60; max jitter is +25% => advance 75s to be safe
    await clock.tickAsync(75_000);
    expect(client.fetchConfigurations.callCount).toBeGreaterThan(afterFirst);
  });

  it('retries with exponential backoff on initial-fetch failures', async function () {
    client.fetchConfigurations.rejects(new Error('unreachable'));

    poller.start();
    await clock.tickAsync(0);
    expect(client.fetchConfigurations.callCount).toBe(1);

    // First backoff delay is 10s (+ up to 25% jitter)
    await clock.tickAsync(13_000);
    expect(client.fetchConfigurations.callCount).toBe(2);

    // Second backoff delay is 30s
    await clock.tickAsync(38_000);
    expect(client.fetchConfigurations.callCount).toBe(3);
  });

  it('enters degraded polling mode after MAX_BACKOFF_ATTEMPTS initial failures', async function () {
    client.fetchConfigurations.rejects(new Error('unreachable'));

    poller.start();
    await clock.tickAsync(0); // attempt 1
    await clock.tickAsync(13_000); // attempt 2
    await clock.tickAsync(38_000); // attempt 3 -> enters degraded mode
    const countBeforeDegraded = client.fetchConfigurations.callCount;
    expect(countBeforeDegraded).toBe(3);

    // Degraded interval is 300s; advance 380s (incl. jitter headroom) -> one more poll
    await clock.tickAsync(380_000);
    expect(client.fetchConfigurations.callCount).toBe(4);
  });

  it('logs the degraded-mode warning exactly once across repeated degraded polls', async function () {
    const warnSpy = sinon.spy(diag, 'warn');
    client.fetchConfigurations.rejects(new Error('unreachable'));

    poller.start();
    await clock.tickAsync(0); // attempt 1
    await clock.tickAsync(13_000); // attempt 2
    await clock.tickAsync(38_000); // attempt 3 -> enters degraded mode (logs once)
    // Several more degraded polls — the warning must NOT be logged again.
    await clock.tickAsync(380_000);
    await clock.tickAsync(380_000);
    await clock.tickAsync(380_000);

    const degradedWarnings = warnSpy
      .getCalls()
      .filter(c => typeof c.args[0] === 'string' && (c.args[0] as string).includes('degraded polling mode'));
    expect(degradedWarnings.length).toBe(1);
  });

  it('keeps using cached configs and does not crash when a later fetch fails', async function () {
    // First fetch succeeds with a config, later fetch rejects.
    client.fetchConfigurations.onCall(0).resolves(buildResponse(true, [makeApiConfigItem(undefined)]));
    client.fetchConfigurations.onCall(1).rejects(new Error('transient'));

    poller.start();
    await clock.tickAsync(0);
    expect(received.length).toBe(1);

    await clock.tickAsync(75_000); // triggers the failing poll; must not throw
    // No new configs forwarded on failure, but the loop survives
    expect(received.length).toBe(1);
  });

  it('stop() halts the polling loop', async function () {
    client.fetchConfigurations.resolves(buildResponse(false));

    poller.start();
    await clock.tickAsync(0);
    const countAtStop = client.fetchConfigurations.callCount;

    poller.stop();
    await clock.tickAsync(300_000);
    expect(client.fetchConfigurations.callCount).toBe(countAtStop);
  });

  it('stop() before start() is a no-op', function () {
    expect(() => poller.stop()).not.toThrow();
  });
});
