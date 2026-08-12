// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// HTTP family (analog of Java's HttpFamilyTest): verifies the HTTP semconv attributes the extension
// copies onto span metrics, driven by real HTTP/Express instrumentation end-to-end.
import * as assert from 'assert';
import { MockCollector } from '../utils/mock-collector';
import { SERVER_SPAN_NAME } from '../../apps/workload';
import { startFamilyApp } from './family-test-base';

describe('Contract: HTTP attributes family', function () {
  this.timeout(90000);
  let collector: MockCollector;

  before(async function () {
    this.timeout(60000);
    collector = await startFamilyApp({ collectorPort: 4321, appPort: 8141 });
  });
  after(async () => collector.stop());

  it('server: templated route copied; method/status per instrumentation semconv; no high-cardinality keys', () => {
    const attrs = collector.callsAttributes(SERVER_SPAN_NAME)!;
    assert.ok(attrs, 'server calls datapoint present');
    // http.route is current semconv and allowlisted -> always copied.
    assert.strictEqual(attrs['http.route'], '/items/:id');

    // Method/status handling depends on which HTTP semconv the installed instrumentation emits:
    //   - current-semconv instrumentation (newer, or OTEL_SEMCONV_STABILITY_OPT_IN=http): the metric
    //     carries http.request.method + http.response.status_code (int). These are allowlisted.
    //   - legacy-semconv instrumentation (older default): it emits http.method / http.status_code,
    //     which are NOT in the allowlist (no HTTP legacy fallback in the spec), so neither current
    //     nor legacy method/status keys appear.
    // Both are correct; assert exactly one of those two shapes rather than pinning to a version.
    if ('http.request.method' in attrs) {
      assert.strictEqual(attrs['http.request.method'], 'GET');
      assert.strictEqual(attrs['http.response.status_code'], 200);
      assert.strictEqual(typeof attrs['http.response.status_code'], 'number', 'status_code is int per semconv');
    } else {
      assert.ok(!('http.response.status_code' in attrs));
      assert.ok(!('http.method' in attrs), 'legacy http.method is not allowlisted');
      assert.ok(!('http.status_code' in attrs), 'legacy http.status_code is not allowlisted');
    }

    // High-cardinality raw URL/target are never copied, in any semconv.
    assert.ok(!('http.url' in attrs), 'raw url not copied');
    assert.ok(!('http.target' in attrs), 'raw target not copied');
  });

  it('client: downstream call is metered without a route (client has no http.route)', () => {
    const clientAttrs = collector.callsAttributes('GET');
    assert.ok(clientAttrs, 'client calls datapoint present');
    assert.strictEqual(clientAttrs!['span.kind'], 'CLIENT');
    assert.ok(!('http.route' in clientAttrs!), 'client span must not carry http.route');
  });
});
