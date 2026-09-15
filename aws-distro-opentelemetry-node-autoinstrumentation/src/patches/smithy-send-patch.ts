// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared override for the upstream @opentelemetry/instrumentation-aws-sdk's private
// _getV3SmithyClientSendPatch method. Both the full SDK (instrumentation-patch.ts) and
// the lite SDK (opentelemetry-lite-sdk.ts) consume this to avoid maintaining the same
// patch logic in two places.
//
// Behavior differences between modes are gated via OTEL_AWS_LAMBDA_FAST_START:
// - Full mode: suppressTracing + recursion guard for credential extraction
// - Lite mode: simple try/catch (no suppression context needed since lite suppresses
//   internal instrumentation at the AwsInstrumentation config level)
//
// Both modes:
// - Inject X-Ray trace context into outgoing request headers
// - Capture aws.auth.account.access_key and aws.auth.region from client config
// - Capture aws.request.id, aws.request.extended_id, http.status_code from response $metadata

import { context as otelContext, diag, propagation, trace, defaultTextMapSetter } from '@opentelemetry/api';

const XRAY_TRACE_ID_HEADER = 'x-amzn-trace-id';
const XRAY_TRACE_ID_HEADER_CAPITALIZED = 'X-Amzn-Trace-Id';

// Fields of the tracing header that carry the trace, and so are ours to replace.
// Everything else on it belongs to the platform and has to survive the replacement.
const OWNED_TRACE_HEADER_FIELDS = ['Root', 'Parent', 'Sampled'];

/**
 * Fields of a tracing header that belong to the platform rather than to the tracer.
 *
 * `Lineage` is how Lambda counts the hops of one triggering event; it stops invoking a
 * function after roughly sixteen in a chain, through Lambda, S3, SQS and SNS. `Self` is
 * the trace id an Application Load Balancer stamps for the hop it handled. Injecting
 * builds a fresh `Root=..;Parent=..;Sampled=..` and replaces the header with it, so these
 * only survive if they are carried across deliberately.
 *
 * Unrecognised fields are carried too. That is the convention on this header - an ALB
 * documents that "an application can add arbitrary fields for its own purposes. The load
 * balancer preserves these fields but does not use them" - and it means a field added
 * later needs no change here.
 */
function carriedTraceHeaderFields(header?: string): string[] {
  return (header ?? '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0 && !OWNED_TRACE_HEADER_FIELDS.some(key => part.startsWith(`${key}=`)));
}

/**
 * The tracing header this request would have gone out with, had this not replaced it.
 *
 * The AWS SDK's own `recursionDetectionMiddleware` sits on the same `build` step at
 * `low` priority - after this one, which defaults to `normal` - and only sets the header
 * `if (!request.headers.hasOwnProperty(traceIdHeader))`. Writing the header here means it
 * never runs, so what it would have forwarded has to be read from where it reads it.
 *
 * A header already on the request wins, so a caller that set one explicitly is respected.
 */
function replacedTraceHeader(headers: Record<string, string>): string | undefined {
  const existing = Object.keys(headers ?? {}).find(name => name.toLowerCase() === XRAY_TRACE_ID_HEADER);
  return (existing && headers[existing]) || process.env['_X_AMZN_TRACE_ID'];
}

const isLiteMode = (): boolean => (process.env.OTEL_AWS_LAMBDA_FAST_START || 'false').toLowerCase() === 'true';

// Symbol to prevent infinite recursion during credential capture in full mode.
// When extracting credentials, the AWS SDK may make additional API calls (e.g. STS)
// which go through the same instrumented send method. Without this guard, each
// credential request triggers another extraction attempt.
export const SKIP_CREDENTIAL_CAPTURE_KEY = Symbol('skip-credential-capture');

/**
 * Overrides the upstream _getV3SmithyClientSendPatch on an AwsInstrumentation instance
 * to add ADOT middlewares (X-Ray context injection, credential extraction, response
 * metadata capture).
 *
 * The upstream AwsInstrumentation already registers the require hook for
 * @smithy/core/dist-cjs/submodules/client/index.js in its init(), so callers only
 * need to override the patch factory — not re-register the hook.
 */
export function applySmithySendPatch(awsInstrumentation: any): void {
  if (!awsInstrumentation) return;

  try {
    const instr = awsInstrumentation;

    // The upstream binds `moduleVersion` as the first argument via
    // `_getV3SmithyClientSendPatch.bind(this, moduleVersion)`, and shimmer
    // appends `(original, name)`. Pick `original` by type so we're robust to
    // either the bound `(moduleVersion, original, name)` or unbound `(original, name)`.
    instr['_getV3SmithyClientSendPatch'] = function (this: any, ...factoryArgs: unknown[]) {
      const self = this;
      const original = factoryArgs.find(arg => typeof arg === 'function') as (...args: unknown[]) => Promise<any>;

      return function send(this: any, command: any, ...args: unknown[]): Promise<any> {
        if (!this.__adotMiddlewarePatched) {
          if (self.patchV3MiddlewareStack) {
            self.patchV3MiddlewareStack(undefined, this.middlewareStack);
          }

          // Middleware 1: Inject X-Ray trace context into outgoing HTTP headers
          this.middlewareStack?.add(
            (next: any) => async (middlewareArgs: any) => {
              // Read before injecting: inject replaces the header rather than merging
              // into it, so anything already there is gone by the time it returns.
              const carried = carriedTraceHeaderFields(replacedTraceHeader(middlewareArgs.request.headers));
              propagation.inject(otelContext.active(), middlewareArgs.request.headers, defaultTextMapSetter);
              const xrayId = middlewareArgs.request.headers[XRAY_TRACE_ID_HEADER];
              if (xrayId) {
                middlewareArgs.request.headers[XRAY_TRACE_ID_HEADER_CAPITALIZED] = [xrayId, ...carried].join(';');
                delete middlewareArgs.request.headers[XRAY_TRACE_ID_HEADER];
              }
              return await next(middlewareArgs);
            },
            { step: 'build', name: '_adotInjectXrayContextMiddleware', override: true }
          );

          // Middleware 2: Extract credentials (account access key + region)
          const clientConfig = this.config;
          if (isLiteMode()) {
            // Lite mode: simple try/catch, no suppression context
            this.middlewareStack?.add(
              (next: any) => async (middlewareArgs: any) => {
                const span = trace.getSpan(otelContext.active());
                if (span) {
                  try {
                    if (clientConfig.credentials instanceof Function) {
                      const creds = await clientConfig.credentials();
                      if (creds?.accessKeyId) {
                        span.setAttribute('aws.auth.account.access_key', creds.accessKeyId);
                      }
                    }
                    if (clientConfig.region instanceof Function) {
                      const region = await clientConfig.region();
                      if (region) {
                        span.setAttribute('aws.auth.region', region);
                      }
                    }
                  } catch (_) {
                    /* best-effort */
                  }
                }
                return await next(middlewareArgs);
              },
              { step: 'build', name: '_adotExtractCredentials', override: true }
            );
          } else {
            // Full mode: suppressTracing + recursion guard to prevent infinite loops
            // when credential providers make their own AWS API calls
            const { suppressTracing } = require('@opentelemetry/core');
            this.middlewareStack?.add(
              (next: any) => async (middlewareArgs: any) => {
                const activeContext = otelContext.active();
                if (activeContext.getValue(SKIP_CREDENTIAL_CAPTURE_KEY)) {
                  return await next(middlewareArgs);
                }
                const span = trace.getSpan(activeContext);
                if (span) {
                  const suppressedContext = suppressTracing(activeContext).setValue(SKIP_CREDENTIAL_CAPTURE_KEY, true);
                  if (suppressedContext.getValue(SKIP_CREDENTIAL_CAPTURE_KEY)) {
                    await otelContext.with(suppressedContext, async () => {
                      try {
                        if (clientConfig.credentials instanceof Function) {
                          const credentials = await clientConfig.credentials();
                          if (credentials?.accessKeyId) {
                            span.setAttribute('aws.auth.account.access_key', credentials.accessKeyId);
                          }
                        }
                        if (clientConfig.region instanceof Function) {
                          const region = await clientConfig.region();
                          if (region) {
                            span.setAttribute('aws.auth.region', region);
                          }
                        }
                      } catch (err) {
                        diag.debug('Failed to get auth account access key and region:', err);
                      }
                    });
                  }
                }
                return await next(middlewareArgs);
              },
              { step: 'build', name: '_adotExtractSignerCredentials', override: true }
            );
          }

          // Middleware 3: Capture response metadata (request ID, extended ID, HTTP status)
          this.middlewareStack?.add(
            (next: any) => async (middlewareArgs: any) => {
              const result = await next(middlewareArgs);
              const span = trace.getSpan(otelContext.active());
              if (span && result?.output?.$metadata) {
                const meta = result.output.$metadata;
                if (meta.requestId) {
                  span.setAttribute('aws.request.id', meta.requestId);
                }
                if (meta.extendedRequestId) {
                  span.setAttribute('aws.request.extended_id', meta.extendedRequestId);
                }
                if (meta.httpStatusCode) {
                  span.setAttribute('http.status_code', meta.httpStatusCode);
                }
              }
              return result;
            },
            { step: 'deserialize', name: '_adotCaptureResponseMetadata', override: true }
          );

          this.__adotMiddlewarePatched = true;
        }

        command[Symbol.for('opentelemetry.instrumentation.aws-sdk.client.config')] = this.config;
        return original.apply(this, [command, ...args]);
      };
    };
  } catch (e) {
    diag.debug('Failed to apply smithy send patch', e);
  }
}
