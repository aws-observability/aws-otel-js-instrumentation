// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from 'http';

// A minimal OTLP/HTTP JSON collector for contract tests. It records exported spans and span-metric
// datapoints so tests can assert the 100%-metrics-vs-sampled-traces contract and attribute shapes.
// Mirrors the role of the Java contract tests' MockCollector.

export interface MetricDataPoint {
  attributes: Record<string, string | number | boolean>;
  value: number;
}

export class MockCollector {
  private server: http.Server | undefined;
  private exportedSpanNames: string[] = [];
  private callsByName: Map<string, MetricDataPoint[]> = new Map<string, MetricDataPoint[]>();
  private durationSpanNames: Set<string> = new Set<string>();
  private durationUnit: string | undefined;

  async start(port: number): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        try {
          const json = JSON.parse(body || '{}');
          if (req.url?.includes('/v1/traces')) {
            this.ingestTraces(json);
          } else if (req.url?.includes('/v1/metrics')) {
            this.ingestMetrics(json);
          }
        } catch {
          // ignore malformed payloads in tests
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>(resolve => this.server!.listen(port, resolve));
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = undefined;
    }
  }

  reset(): void {
    this.exportedSpanNames = [];
    this.callsByName.clear();
    this.durationSpanNames.clear();
    this.durationUnit = undefined;
  }

  countExportedSpans(name: string): number {
    return this.exportedSpanNames.filter(n => n === name).length;
  }

  callsValue(name: string): number {
    const dps = this.callsByName.get(name) ?? [];
    // cumulative temporality: latest datapoint per (name) holds the running total; sum across series
    // for that span name is what the tests assert against a known request count.
    return dps.reduce((acc, dp) => acc + dp.value, 0);
  }

  callsAttributes(name: string): Record<string, string | number | boolean> | undefined {
    return this.callsByName.get(name)?.[0]?.attributes;
  }

  hasDuration(name: string): boolean {
    return this.durationSpanNames.has(name);
  }

  durationUnitSeen(): string | undefined {
    return this.durationUnit;
  }

  private ingestTraces(json: any): void {
    for (const rs of json.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          this.exportedSpanNames.push(span.name);
        }
      }
    }
  }

  private ingestMetrics(json: any): void {
    for (const rm of json.resourceMetrics ?? []) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          if (m.name === 'traces.span.metrics.calls') {
            for (const dp of m.sum?.dataPoints ?? []) {
              const attributes = decodeAttributes(dp.attributes ?? []);
              const value = Number(dp.asInt ?? dp.asDouble ?? 0);
              const name = String(attributes['span.name'] ?? '');
              // Replace prior datapoints for this span name (cumulative running total).
              this.callsByName.set(name, [{ attributes, value }]);
            }
          } else if (m.name === 'traces.span.metrics.duration') {
            this.durationUnit = m.unit;
            for (const dp of m.histogram?.dataPoints ?? []) {
              const attributes = decodeAttributes(dp.attributes ?? []);
              this.durationSpanNames.add(String(attributes['span.name'] ?? ''));
            }
          }
        }
      }
    }
  }
}

function decodeAttributes(kvs: any[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of kvs) {
    const v = kv.value ?? {};
    if (v.stringValue !== undefined) out[kv.key] = v.stringValue;
    else if (v.intValue !== undefined) out[kv.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[kv.key] = v.doubleValue;
    else if (v.boolValue !== undefined) out[kv.key] = v.boolValue;
  }
  return out;
}
