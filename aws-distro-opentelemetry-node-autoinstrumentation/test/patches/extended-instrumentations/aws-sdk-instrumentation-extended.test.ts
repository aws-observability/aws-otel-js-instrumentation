// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as sinon from 'sinon';
import { AwsSdkInstrumentationExtended } from '../../../src/patches/extended-instrumentations/aws-sdk-instrumentation-extended';
import expect from 'expect';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { Context, TextMapSetter } from '@opentelemetry/api';

describe('AwsSdkInstrumentationExtended', () => {
  let instrumentation: AwsSdkInstrumentationExtended;

  beforeEach(() => {
    instrumentation = new AwsSdkInstrumentationExtended({});
  });

  afterEach(() => {
    sinon.restore();
  });

  it('overridden _getV3SmithyClientSendPatch updates MiddlewareStack', async () => {
    const mockedMiddlewareStackInternal: any = [];
    const mockedMiddlewareStack = {
      add: (arg1: any, arg2: any) => mockedMiddlewareStackInternal.push([arg1, arg2]),
    };
    const send = instrumentation
      ._getV3SmithyClientSendPatch((...args: unknown[]) => Promise.resolve())
      .bind({ middlewareStack: mockedMiddlewareStack });
    sinon
      .stub(AWSXRayPropagator.prototype, 'inject')
      .callsFake((context: Context, carrier: unknown, setter: TextMapSetter) => {
        (carrier as any)['isCarrierModified'] = 'carrierIsModified';
      });

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    await send({}, null);

    const middlewareArgs: any = {
      request: {
        headers: {},
      },
    };
    await mockedMiddlewareStackInternal[0][0]((arg: any) => Promise.resolve(), null)(middlewareArgs);

    expect(middlewareArgs.request.headers['isCarrierModified']).toEqual('carrierIsModified');
    expect(mockedMiddlewareStackInternal[0][1].name).toEqual('_adotInjectXrayContextMiddleware');
  });
});
