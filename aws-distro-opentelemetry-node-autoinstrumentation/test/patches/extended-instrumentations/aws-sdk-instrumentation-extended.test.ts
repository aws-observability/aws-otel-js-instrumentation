// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as sinon from 'sinon';
import { AwsSdkInstrumentationExtended } from '../../../src/patches/extended-instrumentations/aws-sdk-instrumentation-extended';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import expect from 'expect';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { Context, TextMapSetter } from '@opentelemetry/api';
import { HttpRequest } from '@smithy/protocol-http';

describe('AwsSdkInstrumentationExtended', () => {
  let instrumentation: AwsSdkInstrumentationExtended;

  beforeEach(() => {
    instrumentation = new AwsSdkInstrumentationExtended({});
  });

  afterEach(() => {
    sinon.restore();
  });

  it('overridden init patches smithy HttpRequest', () => {
    sinon.stub(AwsInstrumentation.prototype as any, 'init').returns([]);
    sinon
      .stub(AWSXRayPropagator.prototype, 'inject')
      .callsFake((context: Context, carrier: unknown, setter: TextMapSetter) => {
        (carrier as any)['isCarrierModified'] = 'carrierIsModified';
      });
    const result = (instrumentation as any).init();
    expect(result.length).toEqual(1);

    const patchedHttpRequestObject = new HttpRequest({});
    expect(patchedHttpRequestObject.headers['isCarrierModified']).toEqual('carrierIsModified');
  });
});
