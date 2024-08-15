// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DiagLogFunction, DiagLogger, context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import * as http from 'http';
import { GetSamplingRulesResponse, GetSamplingTargetsBody, GetSamplingTargetsResponse } from './remote-sampler.types';

export class AwsXraySamplingClient {
  private getSamplingRulesEndpoint: string;
  private samplingTargetsEndpoint: string;
  private samplerDiag: DiagLogger;

  constructor(endpoint: string, samplerDiag: DiagLogger) {
    this.getSamplingRulesEndpoint = endpoint + '/GetSamplingRules';
    this.samplingTargetsEndpoint = endpoint + '/SamplingTargets';
    this.samplerDiag = samplerDiag;
  }

  public fetchSamplingTargets(
    requestBody: GetSamplingTargetsBody,
    callback: (responseObject: GetSamplingTargetsResponse) => void
  ) {
    this.makeSamplingRequest<GetSamplingTargetsResponse>(
      this.samplingTargetsEndpoint,
      callback,
      this.samplerDiag.debug,
      JSON.stringify(requestBody)
    );
  }

  public fetchSamplingRules(callback: (responseObject: GetSamplingRulesResponse) => void) {
    this.makeSamplingRequest<GetSamplingRulesResponse>(this.getSamplingRulesEndpoint, callback, this.samplerDiag.error);
  }

  private makeSamplingRequest<T>(
    url: string,
    callback: (responseObject: T) => void,
    logger: DiagLogFunction,
    requestBodyJsonString?: string
  ): void {
    const options: http.RequestOptions = {
      method: 'POST',
      headers: {},
    };

    if (requestBodyJsonString) {
      options.headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBodyJsonString),
      };
    }

    // Ensure AWS X-Ray Sampler does not generate traces itself
    context.with(suppressTracing(context.active()), () => {
      const req: http.ClientRequest = http
        .request(url, options, response => {
          response.setEncoding('utf-8');
          let responseData: string = '';
          response.on('data', dataChunk => (responseData += dataChunk));
          response.on('end', () => {
            if (response.statusCode === 200 && responseData.length > 0) {
              let responseObject: T | undefined = undefined;
              try {
                responseObject = JSON.parse(responseData) as T;
              } catch (e: unknown) {
                logger(`Error occurred when parsing responseData from ${url}`);
              }

              if (responseObject) {
                callback(responseObject);
              }
            } else {
              this.samplerDiag.debug(`${url} Response Code is: ${response.statusCode}`);
              this.samplerDiag.debug(`${url} responseData is: ${responseData}`);
            }
          });
        })
        .on('error', (error: unknown) => {
          logger(`Error occurred when making an HTTP POST to ${url}: ${error}`);
        });
      if (requestBodyJsonString) {
        req.end(requestBodyJsonString);
      } else {
        req.end();
      }
    });
  }
}
