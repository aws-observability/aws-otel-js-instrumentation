// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as sinon from 'sinon';
import { StatusReporter } from '../../src/dynamic-instrumentation/status-reporter';
import { DynamicInstrumentationClient } from '../../src/dynamic-instrumentation/client';
import { InstrumentationRegistry } from '../../src/dynamic-instrumentation/registry/instrumentation-registry';
import {
  InstrumentationConfiguration,
  parseInstrumentationConfiguration,
} from '../../src/dynamic-instrumentation/model/instrumentation-configuration';
import { ConfigurationStatus, ErrorCause, InstrumentationType } from '../../src/dynamic-instrumentation/model/types';

/**
 * Build a parsed BREAKPOINT InstrumentationConfiguration with an optional far-future
 * (or past) expiry so we can drive READY/ACTIVE/DISABLED states deterministically.
 */
function makeConfig(locationHash: string, expiresAtIso: string = '2099-12-31T23:59:59Z'): InstrumentationConfiguration {
  const config = parseInstrumentationConfiguration({
    InstrumentationType: 'BREAKPOINT',
    SignalType: 'SNAPSHOT',
    InstrumentationName: `bp-${locationHash}`,
    Location: {
      CodeLocation: {
        Language: 'javascript',
        MethodName: 'handler',
        FilePath: 'src/app.js',
        LineNumber: 10,
      },
    },
    LocationHash: locationHash,
    ExpiresAt: expiresAtIso,
    CaptureConfiguration: { CodeCapture: { CaptureLimits: {} } },
  });
  if (!config) throw new Error('failed to build test config');
  return config;
}

describe('StatusReporter', function () {
  let client: sinon.SinonStubbedInstance<DynamicInstrumentationClient>;
  let registry: InstrumentationRegistry;
  let reporter: StatusReporter;
  let clock: sinon.SinonFakeTimers;

  beforeEach(function () {
    client = sinon.createStubInstance(DynamicInstrumentationClient);
    client.reportStatus.resolves();
    registry = new InstrumentationRegistry();
    reporter = new StatusReporter(client, registry, 'svc', 'prod');
  });

  afterEach(function () {
    if (clock) clock.restore();
    sinon.restore();
  });

  // --- Helper: read the single batch sent to reportStatus on its Nth call ---
  function entriesFromCall(callIndex: number) {
    return client.reportStatus.getCall(callIndex).args[0].Configurations;
  }

  describe('READY reporting', function () {
    it('reports READY once for an installed, unhit config', async function () {
      registry.register(makeConfig('h1'));
      registry.markInstalled([...registry.getAllKeys()][0]);

      reporter.reportNow();
      await Promise.resolve();
      await Promise.resolve();

      expect(client.reportStatus.callCount).toBe(1);
      const entries = entriesFromCall(0);
      expect(entries).toHaveLength(1);
      expect(entries[0].Status).toBe(ConfigurationStatus.READY);
      expect(entries[0].LocationHash).toBe('h1');
    });

    it('does not report READY for a config that is not yet installed', async function () {
      registry.register(makeConfig('h1'));
      // not installed

      reporter.reportNow();
      await Promise.resolve();
      await Promise.resolve();

      expect(client.reportStatus.called).toBe(false);
    });

    it('reports READY only once across multiple report cycles', async function () {
      registry.register(makeConfig('h1'));
      registry.markInstalled([...registry.getAllKeys()][0]);

      reporter.reportNow();
      await Promise.resolve();
      await Promise.resolve();
      reporter.reportNow();
      await Promise.resolve();
      await Promise.resolve();

      expect(client.reportStatus.callCount).toBe(1);
    });
  });

  describe('ACTIVE reporting', function () {
    it('reports ACTIVE when the config has been hit in the period', async function () {
      registry.register(makeConfig('h1'));
      const key = [...registry.getAllKeys()][0];
      registry.markInstalled(key);
      const entry = registry.get(key);
      entry!.state.recordHit(); // hitCount > 0 -> ACTIVE, hitInLastPeriod = true

      reporter.reportNow();
      await Promise.resolve();
      await Promise.resolve();

      const entries = entriesFromCall(0);
      expect(entries.some(e => e.Status === ConfigurationStatus.ACTIVE)).toBe(true);
    });
  });

  describe('DISABLED reporting', function () {
    it('reports DISABLED once when a config has expired', async function () {
      // Expiry in the past -> checkExpiry() disables it during report()
      registry.register(makeConfig('h1', '2000-01-01T00:00:00Z'));
      registry.markInstalled([...registry.getAllKeys()][0]);

      reporter.reportNow();
      await Promise.resolve();
      await Promise.resolve();

      const entries = entriesFromCall(0);
      expect(entries[0].Status).toBe(ConfigurationStatus.DISABLED);

      // Second cycle should not re-report DISABLED
      reporter.reportNow();
      await Promise.resolve();
      await Promise.resolve();
      expect(client.reportStatus.callCount).toBe(1);
    });
  });

  describe('error reporting', function () {
    it('reports an ERROR entry immediately via reportError', async function () {
      reporter.reportError(InstrumentationType.BREAKPOINT, 'h-err', ErrorCause.RUNTIME_ERROR);
      await Promise.resolve();
      await Promise.resolve();

      expect(client.reportStatus.called).toBe(true);
      const entries = entriesFromCall(0);
      expect(entries[0].Status).toBe(ConfigurationStatus.ERROR);
      expect(entries[0].LocationHash).toBe('h-err');
      expect(entries[0].ErrorCause).toBe(ErrorCause.RUNTIME_ERROR);
    });

    it('clears pending errors after they are reported', async function () {
      reporter.reportError(InstrumentationType.BREAKPOINT, 'h-err', ErrorCause.RUNTIME_ERROR);
      await Promise.resolve();
      await Promise.resolve();
      const firstCount = client.reportStatus.callCount;

      // A subsequent report with nothing new pending should not resend the error
      reporter.reportNow();
      await Promise.resolve();
      await Promise.resolve();
      expect(client.reportStatus.callCount).toBe(firstCount);
    });
  });

  describe('no-op cases', function () {
    it('does not call the client when there is nothing to report', async function () {
      reporter.reportNow();
      await Promise.resolve();
      await Promise.resolve();
      expect(client.reportStatus.called).toBe(false);
    });

    it('swallows client errors without throwing', async function () {
      client.reportStatus.rejects(new Error('network down'));
      registry.register(makeConfig('h1'));
      registry.markInstalled([...registry.getAllKeys()][0]);

      reporter.reportNow();
      // Allow the rejected promise to settle without an unhandled rejection
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(client.reportStatus.called).toBe(true);
    });
  });

  describe('lifecycle', function () {
    it('start() schedules periodic reporting and is idempotent', async function () {
      clock = sinon.useFakeTimers();
      registry.register(makeConfig('h1'));
      registry.markInstalled([...registry.getAllKeys()][0]);

      reporter.start();
      reporter.start(); // idempotent — should not double-schedule

      await clock.tickAsync(60_000);
      expect(client.reportStatus.callCount).toBe(1);
    });

    it('stop() clears the timer and sends a final report', async function () {
      clock = sinon.useFakeTimers();
      reporter.start();
      registry.register(makeConfig('h1'));
      registry.markInstalled([...registry.getAllKeys()][0]);

      reporter.stop();
      await clock.tickAsync(0);
      // final report on stop
      expect(client.reportStatus.callCount).toBe(1);

      // After stop, the interval should no longer fire
      await clock.tickAsync(120_000);
      expect(client.reportStatus.callCount).toBe(1);
    });

    it('stop() is a no-op if never started', function () {
      expect(() => reporter.stop()).not.toThrow();
      expect(client.reportStatus.called).toBe(false);
    });
  });
});
