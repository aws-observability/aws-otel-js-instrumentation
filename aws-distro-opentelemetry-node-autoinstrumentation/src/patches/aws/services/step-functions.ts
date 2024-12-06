// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, SpanKind } from '@opentelemetry/api';
import { AwsSdkInstrumentationConfig, NormalizedRequest } from '@opentelemetry/instrumentation-aws-sdk';
import { AWS_ATTRIBUTE_KEYS } from '../../../aws-attribute-keys';
import { RequestMetadata, ServiceExtension } from '../../../third-party/otel/aws/services/ServiceExtension';

export class StepFunctionsServiceExtension implements ServiceExtension {
  requestPreSpanHook(request: NormalizedRequest, _config: AwsSdkInstrumentationConfig): RequestMetadata {
    const stateMachineArn = request.commandInput?.stateMachineArn;
    const activityArn = request.commandInput?.activityArn;

    const spanKind: SpanKind = SpanKind.CLIENT;
    let spanName: string | undefined;

    const spanAttributes: Attributes = {};

    if (stateMachineArn) {
      spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_STATEMACHINE_ARN] = stateMachineArn;
    }

    if (activityArn) {
      spanAttributes[AWS_ATTRIBUTE_KEYS.AWS_STEPFUNCTIONS_ACTIVITY_ARN] = activityArn;
    }

    const isIncoming = false;

    return {
      isIncoming,
      spanAttributes,
      spanKind,
      spanName,
    };
  }
}
