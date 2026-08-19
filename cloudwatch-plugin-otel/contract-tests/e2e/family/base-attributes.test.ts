// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Base-attribute family (analog of Java's BaseAttributesFamilyTest): every datapoint carries the
// short-form base dimensions, with service.name on the metric RESOURCE (not the datapoint),
// driven by real instrumentation end-to-end.
import * as assert from 'assert';
import { MockCollector } from '../utils/mock-collector';
import { SERVER_SPAN_NAME } from '../../apps/workload';
import { FAMILY_SERVICE_NAME, startFamilyApp } from './family-test-base';

describe('Contract: base attributes family', function () {
  this.timeout(90000);
  let collector: MockCollector;

  before(async function () {
    this.timeout(60000);
    collector = await startFamilyApp({ collectorPort: 4320, appPort: 8140 });
  });
  after(async () => collector.stop());

  it('server span carries short-form base dimensions; service.name lives on the resource', () => {
    const attrs = collector.callsAttributes(SERVER_SPAN_NAME);
    assert.ok(attrs, 'server calls datapoint present');
    assert.strictEqual(attrs!['span.kind'], 'SERVER');
    assert.strictEqual(attrs!['span.name'], SERVER_SPAN_NAME);
    assert.strictEqual(attrs!['status.code'], 'UNSET');
    // service.name must NOT be duplicated on the datapoint; the metric resource carries it.
    assert.ok(!('service.name' in attrs!), 'service.name must not be a datapoint attribute');
    const resource = collector.metricResourceAttributes();
    assert.ok(resource, 'metric resource attributes present');
    assert.strictEqual(resource!['service.name'], FAMILY_SERVICE_NAME);
  });

  it('emits calls with the {call} unit', () => {
    assert.strictEqual(collector.callsUnitSeen(), '{call}');
  });
});
