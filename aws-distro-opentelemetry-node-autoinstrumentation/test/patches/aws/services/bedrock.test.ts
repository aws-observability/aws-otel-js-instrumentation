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

      nock(`https://bedrock-agent.${region}.amazonaws.com`)
        .get(`/prompts/${dummyPromptName}`)
        .reply(200, { promptIdentifier: dummyPromptName });

      await bedrock.getPrompt({ promptIdentifier: dummyPromptName }).catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const getPromptSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgent.GetPrompt';
      });
      expect(getPromptSpans.length).toBe(1);
      const getPromptSpan = getPromptSpans[0];
      expect(getPromptSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(getPromptSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(getPromptSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(getPromptSpan.kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('GetAgent', () => {
    it('adds agentId to span', async () => {
      const dummyAgentId: string = 'ABCDEFGH';

      nock(`https://bedrock-agent.${region}.amazonaws.com`)
        .get(`/agents/${dummyAgentId}`)
        .reply(200, {
          agentId: dummyAgentId,
          request: {
            operation: 'GetAgent',
          },
        });

      await bedrock.getAgent({ agentId: dummyAgentId }).catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const getAgentSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgent.GetAgent';
      });
      expect(getAgentSpans.length).toBe(1);
      const getAgentSpan = getAgentSpans[0];
      expect(getAgentSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBe(dummyAgentId);
      expect(getAgentSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(getAgentSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(getAgentSpan.kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('GetKnowledgeBase', () => {
    it('adds knowledgeBaseId to span', async () => {
      const dummyKnowledgeBaseId: string = 'ABCDEFGH';

      nock(`https://bedrock-agent.${region}.amazonaws.com`)
        .get(`/knowledgebases/${dummyKnowledgeBaseId}`)
        .reply(200, { knowledgeBaseId: dummyKnowledgeBaseId });

      await bedrock.getKnowledgeBase({ knowledgeBaseId: dummyKnowledgeBaseId }).catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const getKnowledgeBaseSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgent.GetKnowledgeBase';
      });
      expect(getKnowledgeBaseSpans.length).toBe(1);
      const getKnowledgeBaseSpan = getKnowledgeBaseSpans[0];
      expect(getKnowledgeBaseSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(getKnowledgeBaseSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBe(
        dummyKnowledgeBaseId
      );
      expect(getKnowledgeBaseSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(getKnowledgeBaseSpan.kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('GetDataSource', () => {
    it('adds dataSourceId to span', async () => {
      const dummyDataSourceId: string = 'ABCDEFGH';
      const dummyKnowledgeBaseId: string = 'HGFEDCBA';

      nock(`https://bedrock-agent.${region}.amazonaws.com`)
        .get(`/knowledgebases/${dummyKnowledgeBaseId}/datasources/${dummyDataSourceId}`)
        .reply(200, { dataSourceId: dummyDataSourceId, knowledgeBaseId: dummyKnowledgeBaseId });

      await bedrock
        .getDataSource({ dataSourceId: dummyDataSourceId, knowledgeBaseId: dummyKnowledgeBaseId })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const getDataSourceSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgent.GetDataSource';
      });
      expect(getDataSourceSpans.length).toBe(1);
      const getDataSourceSpan = getDataSourceSpans[0];
      expect(getDataSourceSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(getDataSourceSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(getDataSourceSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBe(dummyDataSourceId);
      expect(getDataSourceSpan.kind).toBe(SpanKind.CLIENT);
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

      nock(`https://bedrock-agent-runtime.${region}.amazonaws.com`)
        .post(`/knowledgebases/${dummyKnowledgeBaseId}/retrieve`)
        .reply(200, {
          knowledgeBaseId: dummyKnowledgeBaseId,
          retrievalQuery: { text: dummyQuery },
        });

      await bedrock
        .retrieve({
          knowledgeBaseId: dummyKnowledgeBaseId,
          retrievalQuery: { text: dummyQuery },
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const retrieveSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgentRuntime.Retrieve';
      });
      expect(retrieveSpans.length).toBe(1);
      const retrieveSpan = retrieveSpans[0];
      expect(retrieveSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(retrieveSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBe(dummyKnowledgeBaseId);
      expect(retrieveSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(retrieveSpan.kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('InvokeAgent', () => {
    it('adds agentId to span', async () => {
      const dummyAgentId: string = 'ABCDEFGH';
      const dummyAgentAliasId: string = 'HGFEDCBA';
      const dummySessionId: string = 'ABC123AB';

      nock(`https://bedrock-agent-runtime.${region}.amazonaws.com`)
        .post(`/agents/${dummyAgentId}/agentAliases/${dummyAgentAliasId}/sessions/${dummySessionId}/text`)
        .reply(200, {
          agentId: dummyAgentId,
          agentAliasId: dummyAgentAliasId,
          sessionId: dummySessionId,
        });

      await bedrock
        .invokeAgent({
          agentId: dummyAgentId,
          agentAliasId: dummyAgentAliasId,
          sessionId: dummySessionId,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const invokeAgentSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockAgentRuntime.InvokeAgent';
      });
      expect(invokeAgentSpans.length).toBe(1);
      const invokeAgentSpan = invokeAgentSpans[0];
      expect(invokeAgentSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBe(dummyAgentId);
      expect(invokeAgentSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(invokeAgentSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(invokeAgentSpan.kind).toBe(SpanKind.CLIENT);
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

      nock(`https://bedrock.${region}.amazonaws.com`).get(`/guardrails/${dummyGuardrailIdentifier}`).reply(200, {
        guardrailId: dummyGuardrailIdentifier,
      });

      await bedrock
        .getGuardrail({
          guardrailIdentifier: dummyGuardrailIdentifier,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const getGuardrailSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'Bedrock.GetGuardrail';
      });
      expect(getGuardrailSpans.length).toBe(1);
      const getGuardrailSpan = getGuardrailSpans[0];

      expect(getGuardrailSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(getGuardrailSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(getGuardrailSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(getGuardrailSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ID]).toBe(dummyGuardrailIdentifier);
      expect(getGuardrailSpan.kind).toBe(SpanKind.CLIENT);
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
    it('Add AI21 Jamba model attributes to span', async () => {
      const modelId: string = 'ai21.jamba-1-5-large-v1:0';
      const prompt: string = 'Describe the purpose of a compiler in one line.';
      const nativeRequest: any = {
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        top_p: 0.8,
        temperature: 0.6,
        max_tokens: 512,
      };
      const mockRequestBody: string = JSON.stringify(nativeRequest);
      const mockResponseBody: any = {
        stop_reason: 'end_turn',
        usage: {
          prompt_tokens: 21,
          completion_tokens: 24,
        },
        choices: [
          {
            finish_reason: 'stop',
          },
        ],
        request: {
          commandInput: {
            modelId: modelId,
          },
        },
      };

      nock(`https://bedrock-runtime.${region}.amazonaws.com`)
        .post(`/model/${encodeURIComponent(modelId)}/invoke`)
        .reply(200, mockResponseBody);

      await bedrock
        .invokeModel({
          modelId: modelId,
          body: mockRequestBody,
        })
        .catch((err: any) => {
          console.log('error', err);
        });

      const testSpans: ReadableSpan[] = getTestSpans();
      const invokeModelSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockRuntime.InvokeModel';
      });
      expect(invokeModelSpans.length).toBe(1);
      const invokeModelSpan = invokeModelSpans[0];
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_SYSTEM]).toBe('aws.bedrock');
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL]).toBe(modelId);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MAX_TOKENS]).toBe(512);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TEMPERATURE]).toBe(0.6);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TOP_P]).toBe(0.8);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_INPUT_TOKENS]).toBe(21);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(24);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
      expect(invokeModelSpan.kind).toBe(SpanKind.CLIENT);
    });
    it('Add Amazon Titan model attributes to span', async () => {
      const modelId: string = 'amazon.titan-text-express-v1';
      const prompt: string = 'Complete this text. It was the best of times it was the worst...';
      const nativeRequest: any = {
        inputText: prompt,
        textGenerationConfig: {
          maxTokenCount: 4096,
          stopSequences: [],
          temperature: 0,
          topP: 1,
        },
      };
      const mockRequestBody: string = JSON.stringify(nativeRequest);
      const mockResponseBody: any = {
        inputTextTokenCount: 15,
        results: [
          {
            tokenCount: 13,
            completionReason: 'CONTENT_FILTERED',
          },
        ],
      };

      nock(`https://bedrock-runtime.${region}.amazonaws.com`)
        .post(`/model/${modelId}/invoke`)
        .reply(200, mockResponseBody);

      await bedrock
        .invokeModel({
          modelId: modelId,
          body: mockRequestBody,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const invokeModelSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockRuntime.InvokeModel';
      });
      expect(invokeModelSpans.length).toBe(1);
      const invokeModelSpan = invokeModelSpans[0];
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_SYSTEM]).toBe('aws.bedrock');
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL]).toBe(modelId);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MAX_TOKENS]).toBe(4096);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TEMPERATURE]).toBe(0);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TOP_P]).toBe(1);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_INPUT_TOKENS]).toBe(15);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(13);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_RESPONSE_FINISH_REASONS]).toEqual([
        'CONTENT_FILTERED',
      ]);
      expect(invokeModelSpan.kind).toBe(SpanKind.CLIENT);
    });

    it('Add Anthropic Claude model attributes to span', async () => {
      const modelId: string = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
      const prompt: string = 'Complete this text. It was the best of times it was the worst...';
      const nativeRequest: any = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1000,
        temperature: 1.0,
        top_p: 1,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        ],
      };
      const mockRequestBody: string = JSON.stringify(nativeRequest);
      const mockResponseBody: any = {
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 15,
          output_tokens: 13,
        },
        request: {
          commandInput: {
            modelId: modelId,
          },
        },
      };

      nock(`https://bedrock-runtime.${region}.amazonaws.com`)
        .post(`/model/${encodeURIComponent(modelId)}/invoke`)
        .reply(200, mockResponseBody);

      await bedrock
        .invokeModel({
          modelId: modelId,
          body: mockRequestBody,
        })
        .catch((err: any) => {
          console.log('error', err);
        });

      const testSpans: ReadableSpan[] = getTestSpans();
      const invokeModelSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockRuntime.InvokeModel';
      });
      expect(invokeModelSpans.length).toBe(1);
      const invokeModelSpan = invokeModelSpans[0];
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_SYSTEM]).toBe('aws.bedrock');
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL]).toBe(modelId);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MAX_TOKENS]).toBe(1000);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TEMPERATURE]).toBe(1.0);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TOP_P]).toBe(1);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_INPUT_TOKENS]).toBe(15);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(13);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['end_turn']);
      expect(invokeModelSpan.kind).toBe(SpanKind.CLIENT);
    });

    it('Add Cohere Command model attributes to span', async () => {
      const modelId: string = 'cohere.command-light-text-v14';
      const prompt: string = "Describe the purpose of a 'hello world' program in one line";
      const nativeRequest: any = {
        prompt: prompt,
        max_tokens: 512,
        temperature: 0.5,
        p: 0.65,
      };
      const mockRequestBody: string = JSON.stringify(nativeRequest);
      const mockResponseBody: any = {
        generations: [
          {
            finish_reason: 'COMPLETE',
            text: 'test-generation-text',
          },
        ],
        prompt: prompt,
        request: {
          commandInput: {
            modelId: modelId,
          },
        },
      };

      nock(`https://bedrock-runtime.${region}.amazonaws.com`)
        .post(`/model/${encodeURIComponent(modelId)}/invoke`)
        .reply(200, mockResponseBody);

      await bedrock
        .invokeModel({
          modelId: modelId,
          body: mockRequestBody,
        })
        .catch((err: any) => {
          console.log('error', err);
        });

      const testSpans: ReadableSpan[] = getTestSpans();
      const invokeModelSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockRuntime.InvokeModel';
      });
      expect(invokeModelSpans.length).toBe(1);
      const invokeModelSpan = invokeModelSpans[0];
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_SYSTEM]).toBe('aws.bedrock');
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL]).toBe(modelId);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MAX_TOKENS]).toBe(512);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TEMPERATURE]).toBe(0.5);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TOP_P]).toBe(0.65);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_INPUT_TOKENS]).toBe(10);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(4);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['COMPLETE']);
      expect(invokeModelSpan.kind).toBe(SpanKind.CLIENT);
    });

    it('Add Cohere Command R model attributes to span', async () => {
      const modelId: string = 'cohere.command-r-v1:0"';
      const prompt: string = "Describe the purpose of a 'hello world' program in one line";
      const nativeRequest: any = {
        message: prompt,
        max_tokens: 512,
        temperature: 0.5,
        p: 0.65,
      };
      const mockRequestBody: string = JSON.stringify(nativeRequest);
      const mockResponseBody: any = {
        finish_reason: 'COMPLETE',
        text: 'test-generation-text',
        prompt: prompt,
        request: {
          commandInput: {
            modelId: modelId,
          },
        },
      };

      nock(`https://bedrock-runtime.${region}.amazonaws.com`)
        .post(`/model/${encodeURIComponent(modelId)}/invoke`)
        .reply(200, mockResponseBody);

      await bedrock
        .invokeModel({
          modelId: modelId,
          body: mockRequestBody,
        })
        .catch((err: any) => {
          console.log('error', err);
        });

      const testSpans: ReadableSpan[] = getTestSpans();
      const invokeModelSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockRuntime.InvokeModel';
      });
      expect(invokeModelSpans.length).toBe(1);
      const invokeModelSpan = invokeModelSpans[0];
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_SYSTEM]).toBe('aws.bedrock');
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL]).toBe(modelId);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MAX_TOKENS]).toBe(512);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TEMPERATURE]).toBe(0.5);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TOP_P]).toBe(0.65);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_INPUT_TOKENS]).toBe(10);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(4);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['COMPLETE']);
      expect(invokeModelSpan.kind).toBe(SpanKind.CLIENT);
    });

    it('Add Meta Llama model attributes to span', async () => {
      const modelId: string = 'meta.llama2-13b-chat-v1';
      const prompt: string = 'Describe the purpose of an interpreter program in one line.';
      const nativeRequest: any = {
        prompt,
        max_gen_len: 512,
        temperature: 0.5,
        top_p: 0.9,
      };
      const mockRequestBody: string = JSON.stringify(nativeRequest);
      const mockResponseBody: any = {
        prompt_token_count: 31,
        generation_token_count: 49,
        stop_reason: 'stop',
        request: {
          commandInput: {
            modelId: modelId,
          },
        },
      };

      nock(`https://bedrock-runtime.${region}.amazonaws.com`)
        .post(`/model/${encodeURIComponent(modelId)}/invoke`)
        .reply(200, mockResponseBody);

      await bedrock
        .invokeModel({
          modelId: modelId,
          body: mockRequestBody,
        })
        .catch((err: any) => {
          console.log('error', err);
        });

      const testSpans: ReadableSpan[] = getTestSpans();
      const invokeModelSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockRuntime.InvokeModel';
      });
      expect(invokeModelSpans.length).toBe(1);
      const invokeModelSpan = invokeModelSpans[0];
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_SYSTEM]).toBe('aws.bedrock');
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL]).toBe(modelId);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MAX_TOKENS]).toBe(512);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TEMPERATURE]).toBe(0.5);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TOP_P]).toBe(0.9);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_INPUT_TOKENS]).toBe(31);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(49);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
      expect(invokeModelSpan.kind).toBe(SpanKind.CLIENT);
    });

    it('Add Mistral AI model attributes to span', async () => {
      const modelId: string = 'mistral.mistral-7b-instruct-v0:2';
      const prompt: string = `
      <s>[INST] 
      In Bash, how do I list all text files in the current directory 
      (excluding subdirectories) that have been modified in the last month? 
      [/INST]
      `;
      const nativeRequest: any = {
        prompt: prompt,
        max_tokens: 4096,
        temperature: 0.75,
        top_p: 1.0,
      };
      const mockRequestBody: string = JSON.stringify(nativeRequest);
      const mockResponseBody: any = {
        outputs: [
          {
            text: 'test-output-text',
            stop_reason: 'stop',
          },
        ],
        request: {
          commandInput: {
            modelId: modelId,
          },
        },
      };

      nock(`https://bedrock-runtime.${region}.amazonaws.com`)
        .post(`/model/${encodeURIComponent(modelId)}/invoke`)
        .reply(200, mockResponseBody);

      await bedrock
        .invokeModel({
          modelId: modelId,
          body: mockRequestBody,
        })
        .catch((err: any) => {
          console.log('error', err);
        });

      const testSpans: ReadableSpan[] = getTestSpans();
      const invokeModelSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'BedrockRuntime.InvokeModel';
      });
      expect(invokeModelSpans.length).toBe(1);
      const invokeModelSpan = invokeModelSpans[0];
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_DATA_SOURCE_ID]).toBeUndefined();
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_SYSTEM]).toBe('aws.bedrock');
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MODEL]).toBe(modelId);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_MAX_TOKENS]).toBe(4096);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TEMPERATURE]).toBe(0.75);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_REQUEST_TOP_P]).toBe(1.0);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_INPUT_TOKENS]).toBe(31);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(3);
      expect(invokeModelSpan.attributes[AwsSpanProcessingUtil.GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(['stop']);
      expect(invokeModelSpan.kind).toBe(SpanKind.CLIENT);
    });
  });
});
