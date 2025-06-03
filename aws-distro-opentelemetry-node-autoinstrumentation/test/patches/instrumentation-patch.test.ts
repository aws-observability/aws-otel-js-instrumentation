// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Attributes,
  diag,
  Context as OtelContext,
  trace,
  context,
  propagation,
  Span,
  Tracer,
  AttributeValue,
  TextMapSetter,
  INVALID_SPAN_CONTEXT,
} from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { AwsInstrumentation, NormalizedRequest, NormalizedResponse } from '@opentelemetry/instrumentation-aws-sdk';
import { AwsLambdaInstrumentation, AwsLambdaInstrumentationConfig } from '@opentelemetry/instrumentation-aws-lambda';
import { expect } from 'expect';
import { AWS_ATTRIBUTE_KEYS } from '../../src/aws-attribute-keys';
import { RequestMetadata, ServiceExtension } from '../../src/third-party/otel/aws/services/ServiceExtension';
import {
  applyInstrumentationPatches,
  AWSXRAY_TRACE_ID_HEADER_CAPITALIZED,
  customExtractor,
  headerGetter,
} from './../../src/patches/instrumentation-patch';
import * as sinon from 'sinon';
import { AWSXRAY_TRACE_ID_HEADER, AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { Context } from 'aws-lambda';
import { SinonStub } from 'sinon';
import { Lambda } from '@aws-sdk/client-lambda';
import * as nock from 'nock';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { getTestSpans } from '@opentelemetry/contrib-test-utils';
import { instrumentationConfigs } from '../../src/register';

// It is assumed that bedrock.test.ts has already registered the
// necessary instrumentations for testing by calling:
// - `registerInstrumentationTesting(instrumentations[0])`

const _QUEUE_NAME: string = 'queueName';
const _ACTIVITY_ARN: string = 'arn:aws:states:us-east-1:123456789123:activity:testActivity';
const _STATE_MACHINE_ARN: string = 'arn:aws:states:us-east-1:123456789123:stateMachine:testStateMachine';
const _SECRETS_ARN: string = 'arn:aws:secretsmanager:us-east-1:123456789123:secret:testId123456';
const _UUID: string = 'random-uuid';
const _TOPIC_ARN: string = 'arn:aws:sns:us-east-1:123456789012:mystack-mytopic-NZJ5JSMVGFIE';
const _QUEUE_URL: string = 'https://sqs.us-east-1.amazonaws.com/123412341234/queueName';
const _FUNCTION_NAME: string = 'testFunction';
const _FUNCTION_ARN: string = `arn:aws:lambda:us-east-1:123456789012:function:${_FUNCTION_NAME}`;
const _BEDROCK_AGENT_ID: string = 'agentId';
const _BEDROCK_DATASOURCE_ID: string = 'DataSourceId';
const _BEDROCK_GUARDRAIL_ID: string = 'GuardrailId';
const _BEDROCK_GUARDRAIL_ARN: string = 'arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123';
const _BEDROCK_KNOWLEDGEBASE_ID: string = 'KnowledgeBaseId';
const _GEN_AI_SYSTEM: string = 'aws.bedrock';
const _GEN_AI_REQUEST_MODEL: string = 'genAiReuqestModelId';

const mockHeaders = {
  'x-test-header': 'test-value',
  'content-type': 'application/json',
};

const UNPATCHED_INSTRUMENTATIONS: Instrumentation[] = getNodeAutoInstrumentations(instrumentationConfigs);

const PATCHED_INSTRUMENTATIONS: Instrumentation[] = getNodeAutoInstrumentations(instrumentationConfigs);
applyInstrumentationPatches(PATCHED_INSTRUMENTATIONS);

describe('InstrumentationPatchTest', () => {
  it('SanityTestUnpatchedAwsSdkInstrumentation', () => {
    const awsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(awsSdkInstrumentation);

    // Not from patching
    expect(services.has('SQS')).toBeTruthy();
    expect(services.has('SNS')).toBeTruthy();
    expect(services.has('Lambda')).toBeTruthy();
    expect(services.has('DynamoDB')).toBeTruthy();
    expect(services.has('S3')).toBeTruthy();
    expect(services.has('Kinesis')).toBeTruthy();
    // From patching but shouldn't be applied
    expect(services.get('SecretsManager')).toBeFalsy();
    expect(services.get('SFN')).toBeFalsy();
    expect(services.get('SNS')._requestPreSpanHook).toBeFalsy();
    expect(services.get('SNS').requestPreSpanHook).toBeTruthy();
    expect(services.get('Lambda')._requestPreSpanHook).toBeFalsy();
    expect(services.get('Lambda').requestPreSpanHook).toBeTruthy();
    expect(services.get('SQS')._requestPreSpanHook).toBeFalsy();
    expect(services.get('SQS').requestPreSpanHook).toBeTruthy();
    expect(services.has('Bedrock')).toBeFalsy();
    expect(services.has('BedrockAgent')).toBeFalsy();
    expect(services.get('BedrockAgentRuntime')).toBeFalsy();
    expect(services.get('BedrockRuntime')).toBeFalsy();
  });

  it('PatchesAwsSdkInstrumentation', () => {
    const instrumentations: Instrumentation[] = getNodeAutoInstrumentations();
    applyInstrumentationPatches(instrumentations);
    const awsSdkInstrumentation = extractAwsSdkInstrumentation(instrumentations);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const services: Map<string, any> = (awsSdkInstrumentation as AwsInstrumentation).servicesExtensions?.services;
    // Not from patching
    expect(services.has('SQS')).toBeTruthy();
    expect(services.has('SNS')).toBeTruthy();
    expect(services.has('DynamoDB')).toBeTruthy();
    expect(services.has('Lambda')).toBeTruthy();
    expect(services.has('S3')).toBeTruthy();
    expect(services.has('Kinesis')).toBeTruthy();
    // From patching
    expect(services.has('SecretsManager')).toBeTruthy();
    expect(services.has('SFN')).toBeTruthy();
    expect(services.get('SNS')._requestPreSpanHook).toBeTruthy();
    expect(services.get('SNS').requestPreSpanHook).toBeTruthy();
    expect(services.get('Lambda')._requestPreSpanHook).toBeTruthy();
    expect(services.get('Lambda').requestPreSpanHook).toBeTruthy();
    expect(services.get('SQS')._requestPreSpanHook).toBeTruthy();
    expect(services.get('SQS').requestPreSpanHook).toBeTruthy();
    expect(services.has('Bedrock')).toBeTruthy();
    expect(services.has('BedrockAgent')).toBeTruthy();
    expect(services.get('BedrockAgentRuntime')).toBeTruthy();
    expect(services.get('BedrockRuntime')).toBeTruthy();
    // Sanity check
    expect(services.has('InvalidService')).toBeFalsy();
  });

  it('SQS without patching', () => {
    const unpatchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(unpatchedAwsSdkInstrumentation);
    expect(() => doExtractSqsAttributes(services)).not.toThrow();

    let sqsAttributes: Attributes = doExtractSqsAttributes(services, false);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL]).toBeUndefined();
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME]).toBeUndefined();

    sqsAttributes = doExtractSqsAttributes(services, true);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL]).toBeUndefined();
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME]).toBeUndefined();
  });

  it('SNS without patching', () => {
    const unpatchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(unpatchedAwsSdkInstrumentation);
    expect(() => doExtractSNSAttributes(services)).not.toThrow();

    const snsAttributes = doExtractSNSAttributes(services);
    expect(snsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SNS_TOPIC_ARN]).toBeUndefined();
  });

  it('Lambda without patching', () => {
    const unpatchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(unpatchedAwsSdkInstrumentation);
    expect(() => doExtractLambdaAttributes(services)).not.toThrow();

    const lambdaAttributes: Attributes = doExtractLambdaAttributes(services);
    expect(lambdaAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_RESOURCE_MAPPING_ID]).toBeUndefined();
    expect(lambdaAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME]).toBeUndefined();
    expect(lambdaAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_ARN]).toBeUndefined();
  });

  it('SFN without patching', () => {
    const unpatchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(unpatchedAwsSdkInstrumentation);
    expect(() => doExtractSFNAttributes(services)).toThrow();
  });

  it('SecretsManager without patching', () => {
    const unpatchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(unpatchedAwsSdkInstrumentation);
    expect(() => doExtractSecretsManagerAttributes(services)).toThrow();
  });

  it('Bedrock without patching', () => {
    const unpatchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(UNPATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(unpatchedAwsSdkInstrumentation);
    expect(() => doExtractBedrockAttributes(services, 'Bedrock')).toThrow();
  });

  it('SNS with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);

    const snsAttributes = doExtractSNSAttributes(services);
    expect(snsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SNS_TOPIC_ARN]).toBe(_TOPIC_ARN);
  });

  it('SQS with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const sqsAttributes: Attributes = doExtractSqsAttributes(services, false);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL]).toEqual(_QUEUE_URL);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME]).toBeUndefined();
  });

  it('SQS with patching if Queue Name was available (but is not)', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const sqsAttributes: Attributes = doExtractSqsAttributes(services, true);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL]).toEqual(_QUEUE_URL);
    expect(sqsAttributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME]).toEqual(_QUEUE_NAME);
  });

  it('Lambda with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const requestLambdaAttributes: Attributes = doExtractLambdaAttributes(services);
    expect(requestLambdaAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_RESOURCE_MAPPING_ID]).toEqual(_UUID);
    expect(requestLambdaAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_NAME]).toEqual(_FUNCTION_NAME);
    const responseLambdaAttributes: Attributes = doResponseHookLambda(services);
    expect(responseLambdaAttributes[AWS_ATTRIBUTE_KEYS.AWS_LAMBDA_FUNCTION_ARN]).toEqual(_FUNCTION_ARN);
  });

  it('SFN with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const requestSFNAttributes: Attributes = doExtractSFNAttributes(services);
    expect(requestSFNAttributes[AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_STATEMACHINE_ARN]).toEqual(_STATE_MACHINE_ARN);
    expect(requestSFNAttributes[AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_ACTIVITY_ARN]).toEqual(_ACTIVITY_ARN);
  });

  it('SecretsManager with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const requestSecretsManagerAttributes: Attributes = doExtractSecretsManagerAttributes(services);

    expect(requestSecretsManagerAttributes[AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN]).toBe(_SECRETS_ARN);

    const responseHookSecretsManagerAttributes = doResponseHookSecretsManager(services);

    expect(responseHookSecretsManagerAttributes[AWS_ATTRIBUTE_KEYS.AWS_SECRETSMANAGER_SECRET_ARN]).toBe(_SECRETS_ARN);
  });

  it('Bedrock with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const bedrockAttributes: Attributes = doExtractBedrockAttributes(services, 'Bedrock');
    // Expect no-op from attribute extraction in Bedrock
    expect(Object.entries(bedrockAttributes).length).toEqual(0);
    const bedrockAttributesAfterResponse: Attributes = doResponseHookBedrock(services, 'Bedrock');
    expect(Object.entries(bedrockAttributesAfterResponse).length).toBe(2);
    expect(bedrockAttributesAfterResponse[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ID]).toEqual(_BEDROCK_GUARDRAIL_ID);
    expect(bedrockAttributesAfterResponse[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_GUARDRAIL_ARN]).toEqual(
      _BEDROCK_GUARDRAIL_ARN
    );
  });

  it('Bedrock Agent with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);

    const operation_to_expected_attribute: Object = {
      CreateAgentActionGroup: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      CreateAgentAlias: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      DeleteAgentActionGroup: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      DeleteAgentAlias: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      DeleteAgent: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      DeleteAgentVersion: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      GetAgentActionGroup: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      GetAgentAlias: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      GetAgent: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      GetAgentVersion: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      ListAgentActionGroups: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      ListAgentAliases: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      ListAgentKnowledgeBases: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      ListAgentVersions: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      PrepareAgent: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      UpdateAgentActionGroup: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      UpdateAgentAlias: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      UpdateAgent: { 'aws.bedrock.agent.id': _BEDROCK_AGENT_ID },
      AssociateAgentKnowledgeBase: { 'aws.bedrock.knowledge_base.id': _BEDROCK_KNOWLEDGEBASE_ID },
      CreateDataSource: { 'aws.bedrock.knowledge_base.id': _BEDROCK_KNOWLEDGEBASE_ID },
      DeleteKnowledgeBase: { 'aws.bedrock.knowledge_base.id': _BEDROCK_KNOWLEDGEBASE_ID },
      DisassociateAgentKnowledgeBase: { 'aws.bedrock.knowledge_base.id': _BEDROCK_KNOWLEDGEBASE_ID },
      GetAgentKnowledgeBase: { 'aws.bedrock.knowledge_base.id': _BEDROCK_KNOWLEDGEBASE_ID },
      GetKnowledgeBase: { 'aws.bedrock.knowledge_base.id': _BEDROCK_KNOWLEDGEBASE_ID },
      ListDataSources: { 'aws.bedrock.knowledge_base.id': _BEDROCK_KNOWLEDGEBASE_ID },
      UpdateAgentKnowledgeBase: { 'aws.bedrock.knowledge_base.id': _BEDROCK_KNOWLEDGEBASE_ID },
      DeleteDataSource: { 'aws.bedrock.data_source.id': _BEDROCK_DATASOURCE_ID },
      GetDataSource: {
        'aws.bedrock.data_source.id': _BEDROCK_DATASOURCE_ID,
        'aws.bedrock.knowledge_base.id': _BEDROCK_KNOWLEDGEBASE_ID,
      },
      UpdateDataSource: { 'aws.bedrock.data_source.id': _BEDROCK_DATASOURCE_ID },
    };

    for (const [operation, attribute_tuple] of Object.entries(operation_to_expected_attribute)) {
      const bedrockAttributes: Attributes = doExtractBedrockAttributes(services, 'BedrockAgent', operation);

      for (const [attribute_key, attribute_value] of Object.entries(attribute_tuple)) {
        expect(bedrockAttributes[attribute_key]).toEqual(attribute_value);
      }

      const bedrockAgentSuccessAttributes: Attributes = doResponseHookBedrock(services, 'BedrockAgent', operation);

      for (const [attribute_key, attribute_value] of Object.entries(attribute_tuple)) {
        expect(bedrockAgentSuccessAttributes[attribute_key]).toEqual(attribute_value);
      }
    }
  });

  it('Bedrock Agent Runtime with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const bedrockAttributes: Attributes = doExtractBedrockAttributes(services, 'BedrockAgentRuntime');
    expect(Object.entries(bedrockAttributes).length).toBe(2);
    expect(bedrockAttributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_AGENT_ID]).toEqual(_BEDROCK_AGENT_ID);
    expect(bedrockAttributes[AWS_ATTRIBUTE_KEYS.AWS_BEDROCK_KNOWLEDGE_BASE_ID]).toEqual(_BEDROCK_KNOWLEDGEBASE_ID);
    const bedrockAttributesAfterResponse: Attributes = doResponseHookBedrock(services, 'BedrockAgentRuntime');
    expect(Object.entries(bedrockAttributesAfterResponse).length).toBe(0);
  });

  it('Bedrock Runtime with patching', () => {
    const patchedAwsSdkInstrumentation: AwsInstrumentation = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS);
    const services: Map<string, any> = extractServicesFromAwsSdkInstrumentation(patchedAwsSdkInstrumentation);
    const bedrockAttributes: Attributes = doExtractBedrockAttributes(services, 'BedrockRuntime');

    expect(Object.entries(bedrockAttributes).length).toBe(2);
    expect(bedrockAttributes['gen_ai.system']).toEqual(_GEN_AI_SYSTEM);
    expect(bedrockAttributes['gen_ai.request.model']).toEqual(_GEN_AI_REQUEST_MODEL);

    const bedrockAttributesAfterResponse: Attributes = doResponseHookBedrock(services, 'BedrockRuntime');
    expect(Object.entries(bedrockAttributesAfterResponse).length).toBe(0);
  });

  it('Lambda with custom eventContextExtractor patching', () => {
    const patchedAwsSdkInstrumentation: AwsLambdaInstrumentation =
      extractLambdaInstrumentation(PATCHED_INSTRUMENTATIONS);
    expect(
      (patchedAwsSdkInstrumentation.getConfig() as AwsLambdaInstrumentationConfig).eventContextExtractor
    ).not.toBeUndefined();
  });

  function extractAwsSdkInstrumentation(instrumentations: Instrumentation[]): AwsInstrumentation {
    const filteredInstrumentations: Instrumentation[] = instrumentations.filter(
      instrumentation => instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-sdk'
    );
    expect(filteredInstrumentations.length).toEqual(1);
    return filteredInstrumentations[0] as AwsInstrumentation;
  }

  function extractServicesFromAwsSdkInstrumentation(awsSdkInstrumentation: AwsInstrumentation): Map<string, any> {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const services: Map<string, any> = (awsSdkInstrumentation as AwsInstrumentation).servicesExtensions?.services;
    if (services === undefined) {
      throw new Error('extractServicesFromAwsSdkInstrumentation() returned undefined `services`');
    }
    return services;
  }

  function doExtractSqsAttributes(
    services: Map<string, ServiceExtension>,
    includeQueueName: boolean = false
  ): Attributes {
    const serviceName: string = 'SQS';
    const params: NormalizedRequest = {
      serviceName: serviceName,
      commandName: 'mockCommandName',
      commandInput: {
        QueueUrl: _QUEUE_URL,
      },
    };
    if (includeQueueName) {
      params.commandInput.QueueName = _QUEUE_NAME;
    }
    return doExtractAttributes(services, serviceName, params);
  }

  function doExtractSNSAttributes(services: Map<string, ServiceExtension>): Attributes {
    const serviceName: string = 'SNS';
    const params: NormalizedRequest = {
      serviceName: serviceName,
      commandName: 'mockCommandName',
      commandInput: {
        TopicArn: _TOPIC_ARN,
      },
    };
    return doExtractAttributes(services, serviceName, params);
  }

  function doExtractLambdaAttributes(services: Map<string, ServiceExtension>): Attributes {
    const serviceName: string = 'Lambda';
    const params: NormalizedRequest = {
      serviceName: serviceName,
      commandName: 'mockCommandName',
      commandInput: {
        UUID: _UUID,
        FunctionName: _FUNCTION_NAME,
      },
    };
    return doExtractAttributes(services, serviceName, params);
  }

  function doExtractSFNAttributes(services: Map<string, ServiceExtension>): Attributes {
    const serviceName: string = 'SFN';
    const params: NormalizedRequest = {
      serviceName: serviceName,
      commandName: 'mockCommandName',
      commandInput: {
        stateMachineArn: _STATE_MACHINE_ARN,
        activityArn: _ACTIVITY_ARN,
      },
    };
    return doExtractAttributes(services, serviceName, params);
  }

  function doExtractSecretsManagerAttributes(services: Map<string, ServiceExtension>): Attributes {
    const serviceName: string = 'SecretsManager';
    const params: NormalizedRequest = {
      serviceName: serviceName,
      commandName: 'mockCommandName',
      commandInput: {
        SecretId: _SECRETS_ARN,
      },
    };
    return doExtractAttributes(services, serviceName, params);
  }

  function doExtractBedrockAttributes(
    services: Map<string, ServiceExtension>,
    serviceName: string,
    operation?: string
  ): Attributes {
    const params: NormalizedRequest = {
      serviceName: serviceName,
      commandName: operation ? operation : 'mockCommandName',
      commandInput: {
        agentId: _BEDROCK_AGENT_ID,
        dataSourceId: _BEDROCK_DATASOURCE_ID,
        knowledgeBaseId: _BEDROCK_KNOWLEDGEBASE_ID,
        guardrailId: _BEDROCK_GUARDRAIL_ID,
        modelId: _GEN_AI_REQUEST_MODEL,
      },
    };
    return doExtractAttributes(services, serviceName, params);
  }

  function doExtractAttributes(
    services: Map<string, ServiceExtension>,
    serviceName: string,
    requestInput: NormalizedRequest
  ): Attributes {
    const serviceExtension: ServiceExtension | undefined = services.get(serviceName);
    if (serviceExtension === undefined) {
      throw new Error(`serviceExtension for ${serviceName} is not defined in the provided Map of services`);
    }
    const requestMetadata: RequestMetadata = serviceExtension.requestPreSpanHook(requestInput, {}, diag);
    return requestMetadata.spanAttributes || {};
  }

  function doResponseHookSecretsManager(services: Map<string, ServiceExtension>): Attributes {
    const results: Partial<NormalizedResponse> = {
      data: {
        ARN: _SECRETS_ARN,
      },

      request: {
        commandInput: {},
        commandName: 'dummy_operation',
        serviceName: 'SecretsManager',
      },
    };

    return doResponseHook(services, 'SecretsManager', results as NormalizedResponse);
  }

  function doResponseHookLambda(services: Map<string, ServiceExtension>): Attributes {
    const results: Partial<NormalizedResponse> = {
      data: {
        Configuration: {
          FunctionArn: _FUNCTION_ARN,
        },
      },
      request: {
        commandInput: {},
        commandName: 'dummy_operation',
        serviceName: 'Lambda',
      },
    };

    return doResponseHook(services, 'Lambda', results as NormalizedResponse);
  }

  function doResponseHookBedrock(
    services: Map<string, ServiceExtension>,
    serviceName: string,
    operation?: string
  ): Attributes {
    const results: Partial<NormalizedResponse> = {
      data: {
        agentId: _BEDROCK_AGENT_ID,
        dataSourceId: _BEDROCK_DATASOURCE_ID,
        knowledgeBaseId: _BEDROCK_KNOWLEDGEBASE_ID,
        guardrailId: _BEDROCK_GUARDRAIL_ID,
        guardrailArn: _BEDROCK_GUARDRAIL_ARN,
        modelId: _GEN_AI_REQUEST_MODEL,
      },
      request: {
        commandInput: {},
        commandName: operation || 'dummy_operation',
        serviceName: serviceName,
      },
    };

    return doResponseHook(services, serviceName, results as NormalizedResponse);
  }

  function doResponseHook(
    services: Map<string, ServiceExtension>,
    serviceName: string,
    params: NormalizedResponse,
    operation?: string
  ): Attributes {
    const serviceExtension: ServiceExtension = services.get(serviceName)!;
    if (serviceExtension === undefined) {
      throw new Error(`serviceExtension for ${serviceName} is not defined in the provided Map of services`);
    }

    const spanAttributes: Attributes = {};
    const mockSpan: Partial<Span> = {};
    // Make span update test version of span attributes
    mockSpan.setAttribute = (key: string, value: AttributeValue) => {
      spanAttributes[key] = value;
      return mockSpan as Span;
    };
    serviceExtension.responseHook?.(params, mockSpan as Span, {} as Tracer, {});

    return spanAttributes;
  }

  function extractLambdaInstrumentation(instrumentations: Instrumentation[]): AwsLambdaInstrumentation {
    const filteredInstrumentations: Instrumentation[] = instrumentations.filter(
      instrumentation => instrumentation.instrumentationName === '@opentelemetry/instrumentation-aws-lambda'
    );
    expect(filteredInstrumentations.length).toEqual(1);
    return filteredInstrumentations[0] as AwsLambdaInstrumentation;
  }

  describe('AwsSdkInstrumentationPatchTest', () => {
    let lambda: Lambda;
    const region = 'us-east-1';

    describe('overridden _getV3SmithyClientSendPatch updates MiddlewareStack', async () => {
      let mockedMiddlewareStackInternal: any;
      let mockedMiddlewareStack;
      let middlewareArgsHeader: any;

      const send = extractAwsSdkInstrumentation(PATCHED_INSTRUMENTATIONS)
        ['_getV3SmithyClientSendPatch']((...args: unknown[]) => Promise.resolve())
        .bind({ middlewareStack: mockedMiddlewareStack });

      const testXrayTraceHeader = 'test-xray-trace-header';

      beforeEach(async () => {
        // Clear environment variables before each test
        mockedMiddlewareStackInternal = [];
        mockedMiddlewareStack = {
          add: (arg1: any, arg2: any) => mockedMiddlewareStackInternal.push([arg1, arg2]),
        };

        middlewareArgsHeader = {
          request: {
            headers: {},
          },
        };

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await send({}, null);
      });

      afterEach(() => {
        sinon.restore();
      });

      it('Updates trace header casing when AWSXRayPropagator injects trace header successfully', async () => {
        sinon
          .stub(AWSXRayPropagator.prototype, 'inject')
          .callsFake((context: OtelContext, carrier: unknown, setter: TextMapSetter) => {
            (carrier as any)['isCarrierModified'] = 'carrierIsModified';
            (carrier as any)[AWSXRAY_TRACE_ID_HEADER] = testXrayTraceHeader;
          });
        await mockedMiddlewareStackInternal[0][0]((arg: any) => Promise.resolve(), null)(middlewareArgsHeader);

        expect(middlewareArgsHeader.request.headers['isCarrierModified']).toEqual('carrierIsModified');
        expect(middlewareArgsHeader.request.headers).not.toHaveProperty(AWSXRAY_TRACE_ID_HEADER);
        expect(middlewareArgsHeader.request.headers).toHaveProperty(AWSXRAY_TRACE_ID_HEADER_CAPITALIZED);
        expect(middlewareArgsHeader.request.headers[AWSXRAY_TRACE_ID_HEADER_CAPITALIZED]).toEqual(testXrayTraceHeader);

        expect(mockedMiddlewareStackInternal[0][1].name).toEqual('_adotInjectXrayContextMiddleware');
      });

      it('Does not set trace header when AWSXRayPropagator does not inject trace header', async () => {
        const invalidContext: OtelContext = {
          getValue: (key: symbol) => ({
            spanContext: () => INVALID_SPAN_CONTEXT,
          }),
          setValue: (key: symbol, value: unknown) => invalidContext,
          deleteValue: (key: symbol) => invalidContext,
        };

        sinon.stub(context, 'active').returns(invalidContext);

        await mockedMiddlewareStackInternal[0][0]((arg: any) => Promise.resolve(), null)(middlewareArgsHeader);

        expect(middlewareArgsHeader.request.headers).not.toHaveProperty(AWSXRAY_TRACE_ID_HEADER);
        expect(middlewareArgsHeader.request.headers).not.toHaveProperty(AWSXRAY_TRACE_ID_HEADER_CAPITALIZED);

        expect(mockedMiddlewareStackInternal[0][1].name).toEqual('_adotInjectXrayContextMiddleware');
      });
    });

    it('injects trace context header into request via propagator', async () => {
      lambda = new Lambda({
        region: region,
        credentials: {
          accessKeyId: 'abcde',
          secretAccessKey: 'abcde',
        },
      });

      const dummyFunctionName: string = 'dummy-function-name';
      let reqHeaders: any = {};

      nock(`https://lambda.${region}.amazonaws.com`)
        .post(`/2015-03-31/functions/${dummyFunctionName}/invocations`)
        .reply(200, function (uri: any, requestBody: any) {
          reqHeaders = this.req.headers;
          return 'null';
        });

      await lambda
        .invoke({
          FunctionName: dummyFunctionName,
        })
        .catch((err: any) => {});

      const testSpans: ReadableSpan[] = getTestSpans();
      const invokeSpans: ReadableSpan[] = testSpans.filter((s: ReadableSpan) => {
        return s.name === 'dummy-function-name Invoke';
      });

      expect(invokeSpans.length).toBe(1);

      const traceId = invokeSpans[0].spanContext().traceId;
      const spanId = invokeSpans[0].spanContext().spanId;
      expect(reqHeaders['x-amzn-trace-id'] as string).toEqual(
        `Root=1-${traceId.substring(0, 8)}-${invokeSpans[0]
          .spanContext()
          .traceId.substring(8, 32)};Parent=${spanId};Sampled=1`
      );
    });
  });
});

describe('customExtractor', () => {
  const traceContextEnvironmentKey = '_X_AMZN_TRACE_ID';
  const MOCK_XRAY_TRACE_ID = '8a3c60f7d188f8fa79d48a391a778fa6';
  const MOCK_XRAY_TRACE_ID_STR = '1-8a3c60f7-d188f8fa79d48a391a778fa6';
  const MOCK_XRAY_PARENT_SPAN_ID = '53995c3f42cd8ad8';
  const MOCK_XRAY_LAMBDA_LINEAGE = 'Lineage=01cfa446:0';

  const TRACE_ID_VERSION = '1'; // Assuming TRACE_ID_VERSION is defined somewhere in the code

  // Common part of the XRAY trace context
  const MOCK_XRAY_TRACE_CONTEXT_COMMON = `Root=${TRACE_ID_VERSION}-${MOCK_XRAY_TRACE_ID_STR};Parent=${MOCK_XRAY_PARENT_SPAN_ID}`;

  // Different versions of the XRAY trace context
  const MOCK_XRAY_TRACE_CONTEXT_SAMPLED = `${MOCK_XRAY_TRACE_CONTEXT_COMMON};Sampled=1;${MOCK_XRAY_LAMBDA_LINEAGE}`;
  //   const MOCK_XRAY_TRACE_CONTEXT_PASSTHROUGH = (
  //     `Root=${TRACE_ID_VERSION}-${MOCK_XRAY_TRACE_ID_STR.slice(0, TRACE_ID_FIRST_PART_LENGTH)}` +
  //     `-${MOCK_XRAY_TRACE_ID_STR.slice(TRACE_ID_FIRST_PART_LENGTH)};${MOCK_XRAY_LAMBDA_LINEAGE}`
  //   );

  // Create the W3C Trace Context (Sampled)
  const MOCK_W3C_TRACE_CONTEXT_SAMPLED = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  // // W3C Trace State
  const MOCK_W3C_TRACE_STATE_KEY = 'vendor_specific_key';
  const MOCK_W3C_TRACE_STATE_VALUE = 'test_value';
  const MOCK_TRACE_STATE = `${MOCK_W3C_TRACE_STATE_KEY}=${MOCK_W3C_TRACE_STATE_VALUE},foo=1,bar=2`;

  let awsPropagatorStub: SinonStub;
  let traceGetSpanStub: SinonStub;
  // let propagationStub: SinonStub;

  beforeEach(() => {
    // Clear environment variables before each test
    delete process.env[traceContextEnvironmentKey];
  });

  afterEach(() => {
    // Restore original methods after each test to ensure stubs don't affect other tests
    sinon.restore();
  });

  it('should extract context from lambda trace header when present', () => {
    const mockLambdaTraceHeader = MOCK_XRAY_TRACE_CONTEXT_SAMPLED;
    process.env[traceContextEnvironmentKey] = mockLambdaTraceHeader;

    const mockParentContext = {} as OtelContext;

    // Partial mock of the Span object
    const mockSpan: Partial<Span> = {
      spanContext: sinon.stub().returns({
        traceId: MOCK_XRAY_TRACE_ID,
        spanId: MOCK_XRAY_PARENT_SPAN_ID,
      }),
    };

    // Stub awsPropagator.extract to return the mockParentContext
    awsPropagatorStub = sinon.stub(AWSXRayPropagator.prototype, 'extract').returns(mockParentContext);

    // Stub trace.getSpan to return the mock span
    traceGetSpanStub = sinon.stub(trace, 'getSpan').returns(mockSpan as Span);

    // Call the customExtractor function
    const event = { headers: {} };
    const result = customExtractor(event, {} as Context);

    // Assertions
    expect(awsPropagatorStub.calledOnce).toBe(true);
    expect(
      awsPropagatorStub.calledWith(
        sinon.match.any,
        { [AWSXRAY_TRACE_ID_HEADER]: mockLambdaTraceHeader },
        sinon.match.any
      )
    ).toBe(true);
    expect(traceGetSpanStub.calledOnce).toBe(true);
    expect(result).toEqual(mockParentContext); // Should return the parent context when valid
  });

  it('should extract context from HTTP headers when lambda trace header is not present', () => {
    delete process.env[traceContextEnvironmentKey];
    const event = {
      headers: {
        traceparent: MOCK_W3C_TRACE_CONTEXT_SAMPLED,
        tracestate: MOCK_TRACE_STATE,
      },
    };
    const mockExtractedContext = {
      getValue: function () {
        return undefined;
      }, // Empty function that returns undefined
    } as unknown as OtelContext;

    const propagationStub = sinon.stub(propagation, 'extract').returns(mockExtractedContext);

    // Call the customExtractor function
    const mockHttpHeaders = event.headers;
    customExtractor(event, {} as Context);

    expect(propagationStub.calledWith(sinon.match.any, mockHttpHeaders, sinon.match.any)).toBe(true);
  });

  it('should return all header keys from the carrier', () => {
    const keys = headerGetter.keys(mockHeaders);
    expect(keys).toEqual(['x-test-header', 'content-type']);
  });

  it('should return the correct header value for a given key', () => {
    const headerValue = headerGetter.get(mockHeaders, 'x-test-header');
    expect(headerValue).toBe('test-value');
  });

  it('should return undefined for a key that does not exist', () => {
    const headerValue = headerGetter.get(mockHeaders, 'non-existent-header');
    expect(headerValue).toBeUndefined();
  });
});
