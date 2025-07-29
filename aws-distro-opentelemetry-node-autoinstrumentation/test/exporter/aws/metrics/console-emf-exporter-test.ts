// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'expect';
import * as sinon from 'sinon';
import { ConsoleEMFExporter } from '../../../../src/exporter/aws/metrics/console-emf-exporter';
import { EMFLog } from '../../../../src/exporter/aws/metrics/emf-exporter-base';

describe('TestConsoleEMFExporter', () => {
  let exporter: ConsoleEMFExporter;

  beforeEach(() => {
    /* Set up test fixtures. */
    exporter = new ConsoleEMFExporter();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('TestNamespaceInitialization', () => {
    /* Test exporter initialization with different namespace scenarios. */
    // Test default namespace
    const defaultExporter = new ConsoleEMFExporter();
    expect(defaultExporter['namespace']).toEqual('default');

    // Test custom namespace
    const customExporter = new ConsoleEMFExporter('CustomNamespace');
    expect(customExporter['namespace']).toEqual('CustomNamespace');

    // Test undefined namespace (should default to 'default')
    const undefinedNamespaceExporter = new ConsoleEMFExporter(undefined);
    expect(undefinedNamespaceExporter['namespace']).toEqual('default');
  });

  it('TestSendLogEvent', () => {
    /* Test that log events are properly sent to console output. */
    // Create a simple log event with EMF-formatted message
    const testMessage: EMFLog = {
      _aws: {
        Timestamp: 1640995200000,
        CloudWatchMetrics: [
          {
            Namespace: 'TestNamespace',
            Dimensions: [['Service']],
            Metrics: [
              {
                Name: 'TestMetric',
                Unit: 'Count',
              },
            ],
          },
        ],
      },
      Service: 'test-service',
      TestMetric: 42,
      Version: '1',
    };

    const logEvent = {
      message: JSON.stringify(testMessage),
      timestamp: 1640995200000,
    };

    // Spy on console.log
    const consoleLogSpy = sinon.spy(console, 'log');

    // Call the method
    exporter['sendLogEvent'](logEvent);

    // Verify the message was printed to console.log
    expect(consoleLogSpy.calledOnce).toBeTruthy();
    expect(consoleLogSpy.calledWith(logEvent.message)).toBeTruthy();

    // Verify the content of the logged message
    const loggedMessage = JSON.parse(consoleLogSpy.firstCall.args[0]);
    expect(loggedMessage).toEqual(testMessage);
  });
});
