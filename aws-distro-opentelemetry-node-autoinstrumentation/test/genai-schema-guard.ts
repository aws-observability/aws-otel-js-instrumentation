// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getTestMemoryExporter } from '@opentelemetry/contrib-test-utils';
import { validateOtelGenaiSchema } from './instrumentation/otel-schema-validator';

// Mocha root hook that validates the GenAI message attributes on every span an
// instrumentation emits, not just the ones an individual test happens to assert on.
const GUARDED_ATTRIBUTES: Array<[string, string]> = [
  ['gen_ai.input.messages', 'gen-ai-input-messages'],
  ['gen_ai.output.messages', 'gen-ai-output-messages'],
  ['gen_ai.system_instructions', 'gen-ai-system-instructions'],
];

// Spans are collected as they are exported so that a test calling resetMemoryExporter()
// partway through does not hide any of them from the check.
const exportedSpans: any[] = [];
let exporterPatched = false;

function patchExporter(): void {
  if (exporterPatched) return;
  const exporter = getTestMemoryExporter() as any;
  if (!exporter) return;
  const originalExport = exporter.export.bind(exporter);
  exporter.export = (spans: any[], resultCallback: any) => {
    exportedSpans.push(...spans);
    return originalExport(spans, resultCallback);
  };
  exporterPatched = true;
}

// The schemas are fetched from the semantic-conventions repo. When they cannot be
// reached the guard disables itself rather than failing every GenAI test.
let schemasReachable: boolean | undefined;

async function areSchemasReachable(): Promise<boolean> {
  if (schemasReachable !== undefined) return schemasReachable;
  try {
    for (const [, schemaName] of GUARDED_ATTRIBUTES) {
      await validateOtelGenaiSchema([], schemaName);
    }
    schemasReachable = true;
  } catch (error: any) {
    if (String(error.message).startsWith('Failed to fetch schema')) {
      console.warn(`  [genai-schema-guard] disabled, schemas unreachable: ${error.message}`);
      schemasReachable = false;
    } else {
      schemasReachable = true;
    }
  }
  return schemasReachable;
}

// Violations are reported once at the end of the run. Throwing from afterEach would
// abort mocha before the remaining tests execute, hiding the rest of the results.
const violations: string[] = [];
const reportedViolations = new Set<string>();

function recordViolation(key: string, detail: string, testName: string): void {
  if (reportedViolations.has(key)) return;
  reportedViolations.add(key);
  violations.push(`${detail}\n      first seen in: ${testName}`);
}

export const mochaHooks = {
  beforeEach(): void {
    patchExporter();
  },

  async afterEach(this: any): Promise<void> {
    patchExporter();
    const spans = exportedSpans.splice(0, exportedSpans.length);
    if (!(await areSchemasReachable())) return;

    const testName = this.currentTest?.fullTitle() ?? '<unknown test>';
    for (const span of spans) {
      for (const [attribute, schemaName] of GUARDED_ATTRIBUTES) {
        const raw = span.attributes?.[attribute];
        if (raw == null) continue;

        let payload: unknown;
        try {
          payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          recordViolation(
            `${attribute}|not-json|${span.name}`,
            `${attribute} on span "${span.name}" is not valid JSON\n      value: ${String(raw).slice(0, 300)}`,
            testName
          );
          continue;
        }

        try {
          await validateOtelGenaiSchema(payload, schemaName);
        } catch (error: any) {
          const reason = String(error.message).replace(/^Schema validation failed: /, '');
          recordViolation(
            `${attribute}|${reason}|${span.name}`,
            `${attribute} on span "${span.name}" does not match ${schemaName}: ${reason}\n` +
              `      value: ${JSON.stringify(payload).slice(0, 300)}`,
            testName
          );
        }
      }
    }
  },

  afterAll(): void {
    if (violations.length === 0) return;
    throw new Error(
      `${violations.length} GenAI semantic convention schema violation(s):\n    - ${violations.join('\n    - ')}`
    );
  },
};
