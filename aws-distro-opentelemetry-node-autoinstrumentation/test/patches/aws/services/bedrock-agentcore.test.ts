// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTestSpans } from '@opentelemetry/contrib-test-utils';
import { BedrockAgentCore } from '@aws-sdk/client-bedrock-agentcore';
import * as nock from 'nock';
import * as sinon from 'sinon';

import { SpanKind } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../../../src/aws-attribute-keys';
import { BedrockAgentCoreServiceExtension } from '../../../../src/patches/aws/services/bedrock-agentcore';

const region = 'us-east-1';

describe('BedrockAgentCore', () => {
  let client: BedrockAgentCore;
  beforeEach(() => {
    client = new BedrockAgentCore({
      region: region,
      credentials: {
        accessKeyId: 'abcde',
        secretAccessKey: 'abcde',
      },
    });
  });

  describe('InvokeAgentRuntime', () => {
    it('adds agentRuntimeArn to span', async () => {
      const dummyArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent-abc123';

      nock(`https://bedrock-agentcore.${region}.amazonaws.com`)
        .post(/\/runtimes\/.*\/invocations/)
        .reply(200, { runtimeSessionId: 'test-session', statusCode: 200 });

      await client
        .invokeAgentRuntime({
          agentRuntimeArn: dummyArn,
          runtimeSessionId: 'test-session-id-abcdefghijklmnop',
          payload: '{"prompt": "hello"}',
          qualifier: 'DEFAULT',
        })
        .catch(() => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const spans = testSpans.filter((s: ReadableSpan) => s.name === 'BedrockAgentCore.InvokeAgentRuntime');
      expect(spans.length).toBe(1);
      expect(spans[0].attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_RUNTIME_ARN]).toBe(dummyArn);
      expect(spans[0].kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('StopRuntimeSession', () => {
    it('adds agentRuntimeArn to span', async () => {
      const dummyArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent-abc123';

      nock(`https://bedrock-agentcore.${region}.amazonaws.com`)
        .post(/\/runtimes\/.*\/stopruntimesession/)
        .reply(200, { runtimeSessionId: 'test-session', statusCode: 200 });

      await client
        .stopRuntimeSession({
          agentRuntimeArn: dummyArn,
          runtimeSessionId: 'test-session-id-abcdefghijklmnop',
          qualifier: 'DEFAULT',
        })
        .catch(() => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const spans = testSpans.filter((s: ReadableSpan) => s.name === 'BedrockAgentCore.StopRuntimeSession');
      expect(spans.length).toBe(1);
      expect(spans[0].attributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_RUNTIME_ARN]).toBe(dummyArn);
      expect(spans[0].kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('StartCodeInterpreterSession', () => {
    it('adds codeInterpreterIdentifier to span', async () => {
      const dummyId = 'my-code-interpreter-abc123';

      nock(`https://bedrock-agentcore.${region}.amazonaws.com`)
        .post(`/code-interpreters/${dummyId}/sessions/start`)
        .reply(200, { codeInterpreterIdentifier: dummyId, sessionId: 'session-123' });

      await client
        .startCodeInterpreterSession({
          codeInterpreterIdentifier: dummyId,
        })
        .catch(() => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const spans = testSpans.filter(
        (s: ReadableSpan) => s.name === 'BedrockAgentCore.StartCodeInterpreterSession'
      );
      expect(spans.length).toBe(1);
      expect(spans[0].attributes[AWS_ATTRIBUTE_KEYS.GEN_AI_CODE_INTERPRETER_ID]).toBe(dummyId);
      expect(spans[0].kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('StartBrowserSession', () => {
    it('adds browserIdentifier to span', async () => {
      const dummyId = 'my-browser-abc123';

      nock(`https://bedrock-agentcore.${region}.amazonaws.com`)
        .post(`/browsers/${dummyId}/sessions/start`)
        .reply(200, { browserIdentifier: dummyId, sessionId: 'session-456' });

      await client
        .startBrowserSession({
          browserIdentifier: dummyId,
        })
        .catch(() => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const spans = testSpans.filter((s: ReadableSpan) => s.name === 'BedrockAgentCore.StartBrowserSession');
      expect(spans.length).toBe(1);
      expect(spans[0].attributes[AWS_ATTRIBUTE_KEYS.GEN_AI_BROWSER_ID]).toBe(dummyId);
      expect(spans[0].kind).toBe(SpanKind.CLIENT);
    });
  });

  describe('GetResourceApiKey', () => {
    it('adds resourceCredentialProviderName to span', async () => {
      const dummyProvider = 'my-credential-provider';

      nock(`https://bedrock-agentcore.${region}.amazonaws.com`)
        .post('/identity/resource/apikey')
        .reply(200, { apiKey: 'dummy-key' });

      await client
        .getResourceApiKey({
          workloadIdentityToken: 'dummy-token',
          resourceCredentialProviderName: dummyProvider,
        })
        .catch(() => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const spans = testSpans.filter((s: ReadableSpan) => s.name === 'BedrockAgentCore.GetResourceApiKey');
      expect(spans.length).toBe(1);
      expect(spans[0].attributes[AWS_ATTRIBUTE_KEYS.AWS_AUTH_CREDENTIAL_PROVIDER]).toBe(dummyProvider);
      expect(spans[0].kind).toBe(SpanKind.CLIENT);
    });
  });
});

describe('BedrockAgentCoreServiceExtension unit tests', () => {
  const extension = new BedrockAgentCoreServiceExtension();

  describe('responseHook', () => {
    it('extracts attributes from response data', () => {
      const setAttributeStub = sinon.stub();
      const mockSpan = { setAttribute: setAttributeStub } as any;

      extension.responseHook(
        { data: { agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/test-id' } } as any,
        mockSpan,
        {} as any,
        {} as any
      );

      expect(setAttributeStub.calledWith(
        AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_RUNTIME_ARN,
        'arn:aws:bedrock-agentcore:us-east-1:123:runtime/test-id'
      )).toBe(true);
    });

    it('extracts nested attributes using dot notation (workloadIdentityDetails.workloadIdentityArn)', () => {
      const setAttributeStub = sinon.stub();
      const mockSpan = { setAttribute: setAttributeStub } as any;

      extension.responseHook(
        {
          data: {
            workloadIdentityDetails: {
              workloadIdentityArn: 'arn:aws:bedrock-agentcore:us-east-1:123:workload-identity/test',
            },
          },
        } as any,
        mockSpan,
        {} as any,
        {} as any
      );

      expect(setAttributeStub.calledWith(
        AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENTCORE_WORKLOAD_IDENTITY_ARN,
        'arn:aws:bedrock-agentcore:us-east-1:123:workload-identity/test'
      )).toBe(true);
    });

    it('does not set attributes when response data is empty', () => {
      const setAttributeStub = sinon.stub();
      const mockSpan = { setAttribute: setAttributeStub } as any;

      extension.responseHook({ data: {} } as any, mockSpan, {} as any, {} as any);

      expect(setAttributeStub.called).toBe(false);
    });

    it('does not set attributes when response data is undefined', () => {
      const setAttributeStub = sinon.stub();
      const mockSpan = { setAttribute: setAttributeStub } as any;

      extension.responseHook({ data: undefined } as any, mockSpan, {} as any, {} as any);

      expect(setAttributeStub.called).toBe(false);
    });
  });

  describe('requestPreSpanHook', () => {
    it('extracts memoryId from request', () => {
      const result = extension.requestPreSpanHook(
        { commandInput: { memoryId: 'mem-abc123' }, commandName: 'GetMemoryRecord' } as any,
        {} as any,
        {} as any
      );

      expect(result.spanAttributes![AWS_ATTRIBUTE_KEYS.GEN_AI_MEMORY_ID]).toBe('mem-abc123');
      expect(result.spanKind).toBe(SpanKind.CLIENT);
    });

    it('returns empty attributes when commandInput has no matching fields', () => {
      const result = extension.requestPreSpanHook(
        { commandInput: { someOtherField: 'value' }, commandName: 'SomeOp' } as any,
        {} as any,
        {} as any
      );

      expect(Object.keys(result.spanAttributes!).length).toBe(0);
    });

    it('handles undefined commandInput', () => {
      const result = extension.requestPreSpanHook(
        { commandInput: undefined, commandName: 'SomeOp' } as any,
        {} as any,
        {} as any
      );

      expect(Object.keys(result.spanAttributes!).length).toBe(0);
    });
  });
});
