// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTestSpans, registerInstrumentationTesting } from '@opentelemetry/contrib-test-utils';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { applyInstrumentationPatches } from './../../../../src/patches/instrumentation-patch';

const instrumentations: AwsInstrumentation[] = [new AwsInstrumentation()];
applyInstrumentationPatches(instrumentations);
registerInstrumentationTesting(instrumentations[0]);

import { Bedrock } from '@aws-sdk/client-bedrock';
import { BedrockAgent } from '@aws-sdk/client-bedrock-agent';
import { BedrockAgentRuntime } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntime } from '@aws-sdk/client-bedrock-runtime';
import * as nock from 'nock';

import { SpanKind } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../../../src/aws-attribute-keys';
import { AwsSpanProcessingUtil } from '../../../../src/aws-span-processing-util';

// This file's contents are being contributed to upstream
// - https://github.com/open-telemetry/opentelemetry-js-contrib/pull/2361

const region = 'us-east-1';

describe('BedrockAgent', () => {
  let bedrock: BedrockAgent;
  beforeEach(() => {
    bedrock = new BedrockAgent({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });

  describe('GetPrompt', () => {
    it('adds no info to span', async () => {
      const dummyPromptName: string = 'dummy-prompt-name';

      nock(`https://bedrock-agent.${region}.amazonaws.com`).post('/').reply(200, {});

      await bedrock.getPrompt({ promptIdentifier: dummyPromptName }).catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const describeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgent.GetPrompt';
      });
      expect(describeSpans.length).toBe(1);
      const creationSpan = describeSpans[0];
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(creationSpan.kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('GetAgent', () => {
    it('adds agentId to span', async () => {
      const dummyAgentId: string = 'ABCDEFGH';

      nock(`https://bedrock-agent.${region}.amazonaws.com`).post('/').reply(200, {});

      await bedrock.getAgent({ agentId: dummyAgentId }).catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const describeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgent.GetAgent';
      });
      expect(describeSpans.length).toBe(1);
      const creationSpan = describeSpans[0];
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBe(dummyAgentId);
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(creationSpan.kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('GetKnowledgeBase', () => {
    it('adds knowledgeBaseId to span', async () => {
      const dummyKnowledgeBaseId: string = 'ABCDEFGH';

      nock(`https://bedrock-agent.${region}.amazonaws.com`).post('/').reply(200, {});

      await bedrock.getKnowledgeBase({ knowledgeBaseId: dummyKnowledgeBaseId }).catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const describeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgent.GetKnowledgeBase';
      });
      expect(describeSpans.length).toBe(1);
      const creationSpan = describeSpans[0];
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBe(dummyKnowledgeBaseId);
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(creationSpan.kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('GetDataSource', () => {
    it('adds dataSourceId to span', async () => {
      const dummyDataSourceId: string = 'ABCDEFGH';
      const dummyKnowledgeBaseId: string = 'HGFEDCBA';

      nock(`https://bedrock-agent.${region}.amazonaws.com`).post('/').reply(200, {});

      await bedrock
        .getDataSource({ dataSourceId: dummyDataSourceId, knowledgeBaseId: dummyKnowledgeBaseId })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const describeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgent.GetDataSource';
      });
      expect(describeSpans.length).toBe(1);
      const creationSpan = describeSpans[0];
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBe(dummyDataSourceId);
      expect(creationSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});

describe('BedrockAgentRuntime', () => {
  let bedrock: BedrockAgentRuntime;
  beforeEach(() => {
    bedrock = new BedrockAgentRuntime({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });

  describe('Retrieve', () => {
    it('adds knowledgeBaseId to span', async () => {
      const dummyKnowledgeBaseId: string = 'ABCDEFGH';
      const dummyQuery: string = 'dummy-query';

      nock(`https://bedrock-agent-runtime.${region}.amazonaws.com`).post('/').reply(200, {});

      await bedrock
        .retrieve({
          knowledgeBaseId: dummyKnowledgeBaseId,
          retrievalQuery: { text: dummyQuery },
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const describeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgentRuntime.Retrieve';
      });
      expect(describeSpans.length).toBe(1);
      const creationSpan = describeSpans[0];
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBe(dummyKnowledgeBaseId);
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(creationSpan.kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('InvokeAgent', () => {
    it('adds agentId to span', async () => {
      const dummyAgentId: string = 'ABCDEFGH';
      const dummyAgentAliasId: string = 'HGFEDCBA';
      const dummySessionId: string = 'ABC123AB';

      nock(`https://bedrock-agent-runtime.${region}.amazonaws.com`).post('/').reply(200, {});

      await bedrock
        .invokeAgent({
          agentId: dummyAgentId,
          agentAliasId: dummyAgentAliasId,
          sessionId: dummySessionId,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const describeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgentRuntime.InvokeAgent';
      });
      expect(describeSpans.length).toBe(1);
      const creationSpan = describeSpans[0];
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBe(dummyAgentId);
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(creationSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});

describe('Bedrock', () => {
  let bedrock: Bedrock;
  beforeEach(() => {
    bedrock = new Bedrock({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });

  describe('GetGuardrail', () => {
    it('adds guardrailId to span', async () => {
      const dummyGuardrailIdentifier: string = 'ABCDEFGH';

      nock(`https://bedrock.${region}.amazonaws.com`).post('/').reply(200, {});

      await bedrock
        .getGuardrail({
          guardrailIdentifier: dummyGuardrailIdentifier,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const describeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'Bedrock.GetGuardrail';
      });
      expect(describeSpans.length).toBe(1);
      const creationSpan = describeSpans[0];
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      // We expect guardrailId to be populated after the responseHook is triggered, which doesn't happen here
      // That case is covered in the instrumentation-patch.test.ts file by mocking the incoming span
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ID]).toBeUndefined();
      expect(creationSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});

describe('BedrockRuntime', () => {
  let bedrock: BedrockRuntime;
  beforeEach(() => {
    bedrock = new BedrockRuntime({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });

  describe('InvokeModel', () => {
    it('adds modelId to span', async () => {
      const dummyModelId: string = 'ABCDEFGH';
      const dummyBody: string = 'HGFEDCBA';

      nock(`https://bedrock-runtime.${region}.amazonaws.com`).post('/').reply(200, {});

      await bedrock
        .invokeModel({
          modelId: dummyModelId,
          body: dummyBody,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const describeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockRuntime.InvokeModel';
      });
      expect(describeSpans.length).toBe(1);
      const creationSpan = describeSpans[0];
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(creationSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(creationSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL]).toBe(dummyModelId);
      expect(creationSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});
