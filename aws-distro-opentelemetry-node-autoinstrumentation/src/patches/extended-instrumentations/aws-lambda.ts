// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import { AwsLambdaInstrumentation } from '@opentelemetry/instrumentation-aws-lambda';
import { diag, Span, SpanStatusCode } from '@opentelemetry/api';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
export class AwsLambdaInstrumentationPatch extends AwsLambdaInstrumentation {
  // Override the upstream private _endSpan method to remove the unnecessary metric force-flush error message
  // https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/plugins/node/opentelemetry-instrumentation-aws-lambda/src/instrumentation.ts#L358-L398
  override _endSpan(span: Span, err: string | Error | null | undefined, callback: () => void) {
    if (err) {
      span.recordException(err);
    }

    let errMessage;
    if (typeof err === 'string') {
      errMessage = err;
    } else if (err) {
      errMessage = err.message;
    }
    if (errMessage) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errMessage,
      });
    }

    span.end();

    const flushers = [];
    if ((this as any)._traceForceFlusher) {
      flushers.push((this as any)._traceForceFlusher());
    } else {
      diag.error(
        'Spans may not be exported for the lambda function because we are not force flushing before callback.'
      );
    }

    Promise.all(flushers).then(callback, callback);
  }
}
