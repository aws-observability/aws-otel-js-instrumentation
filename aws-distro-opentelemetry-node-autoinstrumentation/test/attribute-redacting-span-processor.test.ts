// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, TraceFlags } from '@opentelemetry/api';
import { BatchSpanProcessor, InMemorySpanExporter, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import expect from 'expect';
import {
  AttributeRedactingSpanProcessor,
  ENV_ADOT_REDACT_SPAN_ATTRIBUTES,
  REDACTED_VALUE,
} from '../src/attribute-redacting-span-processor';

interface RedactionTestData {
  name: string;
  environmentVariables: Record<string, string>;
  spanAttributes: Attributes;
  spanEventAttributes: Attributes;
  spanLinkAttributes: Attributes;
  expectedSpanAttributes: Attributes;
  expectedSpanEventAttributes: Attributes;
  expectedSpanLinkAttributes: Attributes;
}

describe('AttributeRedactingSpanProcessorTest', () => {
  it('should redact all attributes that match configured patterns', async () => {
    const testCases: RedactionTestData[] = [
      {
        name: 'configured attribute names',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: ' user.email, request.body, db.statement, gen_ai.prompt, user.email ',
        },
        spanAttributes: {
          'user.email': 'user@example.com',
          'request.body': '{"password":"secret"}',
          'db.statement': 'SELECT * FROM users',
          'gen_ai.prompt': 'private prompt',
          'http.request.method': 'POST',
          'server.address': 'example.com',
        },
        spanEventAttributes: {
          'user.email': 'event-user@example.com',
          'db.statement': "UPDATE users SET password = 'secret'",
          'gen_ai.prompt': 'private event prompt',
          'event.safe': 'keep me',
        },
        spanLinkAttributes: {
          'user.email': 'link-user@example.com',
          'request.body': '{"link_password":"secret"}',
          'db.statement': 'SELECT * FROM linked_users',
          'gen_ai.prompt': 'private link prompt',
          'http.request.method': 'POST',
          'server.address': 'linked.example.com',
        },
        expectedSpanAttributes: {
          'user.email': REDACTED_VALUE,
          'request.body': REDACTED_VALUE,
          'db.statement': REDACTED_VALUE,
          'gen_ai.prompt': REDACTED_VALUE,
          'http.request.method': 'POST',
          'server.address': 'example.com',
        },
        expectedSpanEventAttributes: {
          'user.email': REDACTED_VALUE,
          'db.statement': REDACTED_VALUE,
          'gen_ai.prompt': REDACTED_VALUE,
          'event.safe': 'keep me',
        },
        expectedSpanLinkAttributes: {
          'user.email': REDACTED_VALUE,
          'request.body': REDACTED_VALUE,
          'db.statement': REDACTED_VALUE,
          'gen_ai.prompt': REDACTED_VALUE,
          'http.request.method': 'POST',
          'server.address': 'linked.example.com',
        },
      },
      {
        name: 'wildcard only',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: '*',
        },
        spanAttributes: { first: 'secret', second: 42, third: true },
        spanEventAttributes: { 'event.first': 'secret', 'event.second': 42 },
        spanLinkAttributes: { 'link.first': 'secret', 'link.second': 42, 'link.third': true },
        expectedSpanAttributes: {
          first: REDACTED_VALUE,
          second: REDACTED_VALUE,
          third: REDACTED_VALUE,
        },
        expectedSpanEventAttributes: {
          'event.first': REDACTED_VALUE,
          'event.second': REDACTED_VALUE,
        },
        expectedSpanLinkAttributes: {
          'link.first': REDACTED_VALUE,
          'link.second': REDACTED_VALUE,
          'link.third': REDACTED_VALUE,
        },
      },
      {
        name: 'prefix wildcard',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: 'http.*',
        },
        spanAttributes: {
          'http.request.method': 'GET',
          'http.response.status_code': 200,
          'server.address': 'example.com',
        },
        spanEventAttributes: {
          'http.request.header.authorization': 'secret',
          'event.safe': 'keep me',
        },
        spanLinkAttributes: {
          'http.link.header.authorization': 'secret',
          'link.safe': 'keep me',
        },
        expectedSpanAttributes: {
          'http.request.method': REDACTED_VALUE,
          'http.response.status_code': REDACTED_VALUE,
          'server.address': 'example.com',
        },
        expectedSpanEventAttributes: {
          'http.request.header.authorization': REDACTED_VALUE,
          'event.safe': 'keep me',
        },
        expectedSpanLinkAttributes: {
          'http.link.header.authorization': REDACTED_VALUE,
          'link.safe': 'keep me',
        },
      },
      {
        name: 'suffix wildcard',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: '*.body',
        },
        spanAttributes: {
          'request.body': 'secret',
          'response.body': 'secret',
          'body.size': 42,
        },
        spanEventAttributes: {
          'message.body': 'secret',
          'message.body.size': 42,
        },
        spanLinkAttributes: {
          'link.body': 'secret',
          'link.body.size': 42,
        },
        expectedSpanAttributes: {
          'request.body': REDACTED_VALUE,
          'response.body': REDACTED_VALUE,
          'body.size': 42,
        },
        expectedSpanEventAttributes: {
          'message.body': REDACTED_VALUE,
          'message.body.size': 42,
        },
        expectedSpanLinkAttributes: {
          'link.body': REDACTED_VALUE,
          'link.body.size': 42,
        },
      },
      {
        name: 'multiple wildcard segments',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: 'gen_ai.*.content',
        },
        spanAttributes: {
          'gen_ai.input.content': 'secret input',
          'gen_ai.output.content': 'secret output',
          'gen_ai.request.model': 'model',
        },
        spanEventAttributes: {
          'gen_ai.tool.content': 'secret event',
          'gen_ai.tool.name': 'lookup',
        },
        spanLinkAttributes: {
          'gen_ai.link.content': 'secret link',
          'gen_ai.link.name': 'lookup',
        },
        expectedSpanAttributes: {
          'gen_ai.input.content': REDACTED_VALUE,
          'gen_ai.output.content': REDACTED_VALUE,
          'gen_ai.request.model': 'model',
        },
        expectedSpanEventAttributes: {
          'gen_ai.tool.content': REDACTED_VALUE,
          'gen_ai.tool.name': 'lookup',
        },
        expectedSpanLinkAttributes: {
          'gen_ai.link.content': REDACTED_VALUE,
          'gen_ai.link.name': 'lookup',
        },
      },
      {
        name: 'wildcard mixed with explicit names',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: 'user.email,http.*',
        },
        spanAttributes: {
          'user.email': 'user@example.com',
          'http.route': '/users',
          safe: 'value',
        },
        spanEventAttributes: {
          'user.email': 'event-user@example.com',
          'http.response.body': 'secret',
          'event.safe': 'keep me',
        },
        spanLinkAttributes: {
          'user.email': 'link-user@example.com',
          'http.link': 'secret',
          'link.safe': 'keep me',
        },
        expectedSpanAttributes: {
          'user.email': REDACTED_VALUE,
          'http.route': REDACTED_VALUE,
          safe: 'value',
        },
        expectedSpanEventAttributes: {
          'user.email': REDACTED_VALUE,
          'http.response.body': REDACTED_VALUE,
          'event.safe': 'keep me',
        },
        expectedSpanLinkAttributes: {
          'user.email': REDACTED_VALUE,
          'http.link': REDACTED_VALUE,
          'link.safe': 'keep me',
        },
      },
    ];

    for (let index = 0; index < testCases.length; index += 1) {
      await assertRedaction(testCases[index]);
    }
  });

  it('should not redact attributes for invalid configured patterns', async () => {
    const testCases: RedactionTestData[] = [
      {
        name: 'empty configuration',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: '',
        },
        spanAttributes: { 'user.email': 'user@example.com' },
        spanEventAttributes: { 'user.email': 'event-user@example.com' },
        spanLinkAttributes: { 'user.email': 'link-user@example.com' },
        expectedSpanAttributes: { 'user.email': 'user@example.com' },
        expectedSpanEventAttributes: { 'user.email': 'event-user@example.com' },
        expectedSpanLinkAttributes: { 'user.email': 'link-user@example.com' },
      },
      {
        name: 'empty comma-separated entries',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: ' , , ',
        },
        spanAttributes: { 'request.body': 'secret' },
        spanEventAttributes: { 'request.body': 'event secret' },
        spanLinkAttributes: { 'request.body': 'link secret' },
        expectedSpanAttributes: { 'request.body': 'secret' },
        expectedSpanEventAttributes: { 'request.body': 'event secret' },
        expectedSpanLinkAttributes: { 'request.body': 'link secret' },
      },
      {
        name: 'whitespace-only configuration',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: ' \t ',
        },
        spanAttributes: { 'db.statement': 'SELECT * FROM users' },
        spanEventAttributes: { 'db.statement': 'DELETE FROM users' },
        spanLinkAttributes: { 'db.statement': 'SELECT * FROM linked_users' },
        expectedSpanAttributes: { 'db.statement': 'SELECT * FROM users' },
        expectedSpanEventAttributes: { 'db.statement': 'DELETE FROM users' },
        expectedSpanLinkAttributes: { 'db.statement': 'SELECT * FROM linked_users' },
      },
      {
        name: 'unsupported regular expression',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: 'http\\.request\\..+',
        },
        spanAttributes: { 'http.request.method': 'POST' },
        spanEventAttributes: { 'http.request.body': 'secret' },
        spanLinkAttributes: { 'http.request.header': 'secret' },
        expectedSpanAttributes: { 'http.request.method': 'POST' },
        expectedSpanEventAttributes: { 'http.request.body': 'secret' },
        expectedSpanLinkAttributes: { 'http.request.header': 'secret' },
      },
      {
        name: 'unsupported regular expression anchors',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: '^user.email$',
        },
        spanAttributes: { 'user.email': 'user@example.com' },
        spanEventAttributes: { 'user.email': 'event-user@example.com' },
        spanLinkAttributes: { 'user.email': 'link-user@example.com' },
        expectedSpanAttributes: { 'user.email': 'user@example.com' },
        expectedSpanEventAttributes: { 'user.email': 'event-user@example.com' },
        expectedSpanLinkAttributes: { 'user.email': 'link-user@example.com' },
      },
      {
        name: 'unsupported regular expression character class',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: 'http.request.[a-z]+',
        },
        spanAttributes: { 'http.request.method': 'POST' },
        spanEventAttributes: { 'http.request.body': 'secret' },
        spanLinkAttributes: { 'http.request.header': 'secret' },
        expectedSpanAttributes: { 'http.request.method': 'POST' },
        expectedSpanEventAttributes: { 'http.request.body': 'secret' },
        expectedSpanLinkAttributes: { 'http.request.header': 'secret' },
      },
      {
        name: 'unsupported regular expression alternation',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: 'user.email|request.body',
        },
        spanAttributes: {
          'user.email': 'user@example.com',
          'request.body': 'secret',
        },
        spanEventAttributes: {
          'user.email': 'event-user@example.com',
          'request.body': 'event secret',
        },
        spanLinkAttributes: {
          'user.email': 'link-user@example.com',
          'request.body': 'link secret',
        },
        expectedSpanAttributes: {
          'user.email': 'user@example.com',
          'request.body': 'secret',
        },
        expectedSpanEventAttributes: {
          'user.email': 'event-user@example.com',
          'request.body': 'event secret',
        },
        expectedSpanLinkAttributes: {
          'user.email': 'link-user@example.com',
          'request.body': 'link secret',
        },
      },
      {
        name: 'unsupported question mark wildcard',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: 'http.request.?',
        },
        spanAttributes: { 'http.request.method': 'POST' },
        spanEventAttributes: { 'http.request.body': 'secret' },
        spanLinkAttributes: { 'http.request.header': 'secret' },
        expectedSpanAttributes: { 'http.request.method': 'POST' },
        expectedSpanEventAttributes: { 'http.request.body': 'secret' },
        expectedSpanLinkAttributes: { 'http.request.header': 'secret' },
      },
      {
        name: 'malformed bracket pattern',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: 'http.request.[',
        },
        spanAttributes: { 'http.request.method': 'POST' },
        spanEventAttributes: { 'http.request.body': 'secret' },
        spanLinkAttributes: { 'http.request.header': 'secret' },
        expectedSpanAttributes: { 'http.request.method': 'POST' },
        expectedSpanEventAttributes: { 'http.request.body': 'secret' },
        expectedSpanLinkAttributes: { 'http.request.header': 'secret' },
      },
      {
        name: 'attribute name containing comma',
        environmentVariables: {
          [ENV_ADOT_REDACT_SPAN_ATTRIBUTES]: 'custom,attribute',
        },
        spanAttributes: { 'custom,attribute': 'secret' },
        spanEventAttributes: { 'custom,attribute': 'event secret' },
        spanLinkAttributes: { 'custom,attribute': 'link secret' },
        expectedSpanAttributes: { 'custom,attribute': 'secret' },
        expectedSpanEventAttributes: { 'custom,attribute': 'event secret' },
        expectedSpanLinkAttributes: { 'custom,attribute': 'link secret' },
      },
    ];

    for (let index = 0; index < testCases.length; index += 1) {
      await assertRedaction(testCases[index]);
    }
  });
});

async function assertRedaction(testData: RedactionTestData): Promise<void> {
  const previousEnvironmentVariables: NodeJS.ProcessEnv = {};
  Object.keys(testData.environmentVariables).forEach(environmentVariable => {
    previousEnvironmentVariables[environmentVariable] = process.env[environmentVariable];
  });
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider | undefined;

  try {
    Object.assign(process.env, testData.environmentVariables);
    provider = new NodeTracerProvider({
      spanProcessors: [new AttributeRedactingSpanProcessor(), new BatchSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', {
      attributes: testData.spanAttributes,
      links: [
        {
          context: {
            traceId: '00000000000000000000000000000001',
            spanId: '0000000000000001',
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
          attributes: testData.spanLinkAttributes,
        },
      ],
    });
    span.addEvent('test.event', testData.spanEventAttributes);
    span.end();

    await provider.forceFlush();
    const finishedSpans = exporter.getFinishedSpans();
    expect(finishedSpans).toHaveLength(1);
    expect(finishedSpans[0].attributes).toEqual(testData.expectedSpanAttributes);
    expect(finishedSpans[0].links).toHaveLength(1);
    expect(finishedSpans[0].links[0].attributes).toEqual(testData.expectedSpanLinkAttributes);
    expect(finishedSpans[0].events).toHaveLength(1);
    expect(finishedSpans[0].events[0].name).toBe('test.event');
    expect(finishedSpans[0].events[0].attributes).toEqual(testData.expectedSpanEventAttributes);
  } finally {
    await provider?.shutdown();
    Object.entries(previousEnvironmentVariables).forEach(([environmentVariable, previousValue]) => {
      if (previousValue === undefined) {
        delete process.env[environmentVariable];
      } else {
        process.env[environmentVariable] = previousValue;
      }
    });
  }
}
