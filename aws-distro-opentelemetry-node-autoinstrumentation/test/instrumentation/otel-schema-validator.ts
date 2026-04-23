// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as Ajv from 'ajv';

const OTEL_SCHEMA_BASE = 'https://opentelemetry.io/docs/specs/semconv';
const schemaCache: Record<string, object> = {};

async function fetchSchema(url: string): Promise<object> {
  if (schemaCache[url]) return schemaCache[url];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fetch = require('node-fetch');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch schema from ${url}: ${resp.status}`);
  const schema = await resp.json();
  schemaCache[url] = schema;
  return schema;
}

export async function validateOtelSchema(data: unknown, schemaUrl: string): Promise<void> {
  const schema = await fetchSchema(schemaUrl);
  const ajv = new Ajv({ allErrors: true });
  ajv.addFormat('binary', () => true);
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (!valid) {
    throw new Error(`Schema validation failed: ${ajv.errorsText(validate.errors)}`);
  }
}

export async function validateOtelGenaiSchema(data: unknown, schemaName: string): Promise<void> {
  await validateOtelSchema(data, `${OTEL_SCHEMA_BASE}/gen-ai/${schemaName}.json`);
}
