// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from 'http';

// A minimal OTLP/HTTP JSON collector for contract tests. It records exported spans and span-metric
// datapoints so tests can assert the 100%-metrics-vs-sampled-traces contract and attribute shapes.
// Mirrors the role of the Java contract tests' MockCollector.

// An attribute value as decoded from OTLP JSON. Arrays (e.g. aws.dynamodb.table_names) decode to a
// homogeneous array of the scalar types.
export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];

export interface MetricDataPoint {
  attributes: Record<string, AttributeValue>;
  value: number;
}

export class MockCollector {
  private server: http.Server | undefined;
  private exportedSpanNames: string[] = [];
  private callsByName: Map<string, MetricDataPoint[]> = new Map<string, MetricDataPoint[]>();
  private durationSpanNames: Set<string> = new Set<string>();
  private durationUnit: string | undefined;
  private callsUnit: string | undefined;
  private metricResource: Record<string, AttributeValue> | undefined;

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
    this.callsUnit = undefined;
    this.metricResource = undefined;
  }

  countExportedSpans(name: string): number {
    return this.exportedSpanNames.filter(n => n === name).length;
  }

  // How many times a SERVER endpoint (one logical server span name) was called. Cumulative
  // temporality means each series' stored value is its running total, so summing the SERVER-kind
  // series gives the request count. Summing only SERVER-kind is deliberate: a name may carry
  // non-SERVER series too (the gRPC CLIENT span shares its SERVER span's name), and summing those in
  // would double-count. It also correctly re-aggregates a SERVER endpoint that older instrumentation
  // split into per-request series by a high-cardinality dimension (e.g. net.peer.port): 60 series of
  // value 1 sum back to 60, exactly as a single series of value 60 would.
  callsValue(name: string): number {
    const dps = this.callsByName.get(name) ?? [];
    return dps
      .filter(dp => String(dp.attributes['span.kind'] ?? '') === 'SERVER')
      .reduce((acc, dp) => acc + dp.value, 0);
  }

  callsAttributes(name: string): Record<string, AttributeValue> | undefined {
    return this.callsByName.get(name)?.[0]?.attributes;
  }

  // Attributes of the first calls datapoint for a span name that matches the predicate. Needed when a
  // single span name has more than one series (e.g. gRPC emits a CLIENT and a SERVER span with the
  // same name); callsAttributes() only surfaces one of them.
  findCallsAttributes(
    name: string,
    predicate: (attributes: Record<string, AttributeValue>) => boolean
  ): Record<string, AttributeValue> | undefined {
    return this.callsByName.get(name)?.find(dp => predicate(dp.attributes))?.attributes;
  }

  hasDuration(name: string): boolean {
    return this.durationSpanNames.has(name);
  }

  durationUnitSeen(): string | undefined {
    return this.durationUnit;
  }

  callsUnitSeen(): string | undefined {
    return this.callsUnit;
  }

  // Resource attributes of the ResourceMetrics that carried the span metrics (service.name lives
  // here, not on datapoints).
  metricResourceAttributes(): Record<string, AttributeValue> | undefined {
    return this.metricResource;
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
            this.callsUnit = m.unit;
            this.metricResource = decodeAttributes(rm.resource?.attributes ?? []);
            for (const dp of m.sum?.dataPoints ?? []) {
              const attributes = decodeAttributes(dp.attributes ?? []);
              const value = Number(dp.asInt ?? dp.asDouble ?? 0);
              const name = String(attributes['span.name'] ?? '');
              // Cumulative temporality: the latest datapoint per distinct series holds the running
              // total. One span name can carry more than one series that must be kept separate — the
              // gRPC CLIENT and SERVER spans share a name (the rpc test selects the CLIENT series by
              // span.kind), and on older instrumentation a single SERVER endpoint fans out into one
              // series per value of a high-cardinality dimension (e.g. net.peer.port, the ephemeral
              // client port, differs per request). Key each series by its FULL attribute signature so
              // genuinely-distinct series are all retained, and replace on an exact-signature match so
              // repeated cumulative exports of the same series overwrite (not accumulate).
              const signature = seriesSignature(attributes);
              const series = this.callsByName.get(name) ?? [];
              const existing = series.findIndex(dp2 => seriesSignature(dp2.attributes) === signature);
              if (existing >= 0) {
                series[existing] = { attributes, value };
              } else {
                series.push({ attributes, value });
              }
              this.callsByName.set(name, series);
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

// A stable identity for a metric series: its full, attribute-sorted key/value set. Two datapoints
// with the same signature are the same series across cumulative exports (replace); differing on any
// attribute (e.g. span.kind or net.peer.port) makes them distinct series (keep both).
function seriesSignature(attributes: Record<string, AttributeValue>): string {
  return Object.keys(attributes)
    .sort()
    .map(k => `${k}=${String(attributes[k])}`)
    .join('|');
}

// A minimal shape of an OTLP JSON AnyValue: exactly one of the scalar fields, or an arrayValue whose
// values are themselves AnyValues (e.g. aws.dynamodb.table_names).
interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
}

function decodeAttributes(kvs: { key: string; value?: AnyValue }[]): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const kv of kvs) {
    const decoded = decodeAnyValue(kv.value ?? {});
    if (decoded !== undefined) out[kv.key] = decoded;
  }
  return out;
}

function decodeScalarValue(v: AnyValue): string | number | boolean | undefined {
  if (v.stringValue !== undefined) return v.stringValue;
  else if (v.intValue !== undefined) return Number(v.intValue);
  else if (v.doubleValue !== undefined) return v.doubleValue;
  else if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}

// Decode a single OTLP JSON AnyValue. Arrays ({ arrayValue: { values: AnyValue[] } }, e.g.
// aws.dynamodb.table_names) decode element-wise via the same scalar rules; without this an array
// attribute would be silently dropped from test assertions.
function decodeAnyValue(v: AnyValue): AttributeValue | undefined {
  if (v.arrayValue !== undefined) {
    return (v.arrayValue.values ?? [])
      .map(element => decodeScalarValue(element))
      .filter((element): element is string | number | boolean => element !== undefined) as AttributeValue;
  }
  return decodeScalarValue(v);
}
