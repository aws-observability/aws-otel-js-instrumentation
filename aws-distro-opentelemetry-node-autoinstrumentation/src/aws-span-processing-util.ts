// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue, Context, SpanContext, SpanKind, diag, isSpanContextValid, trace } from '@opentelemetry/api';
import { InstrumentationLibrary } from '@opentelemetry/core';
import { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';

import {
  MessagingOperationValues,
  SEMATTRS_DB_OPERATION,
  SEMATTRS_DB_STATEMENT,
  SEMATTRS_DB_SYSTEM,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_TARGET,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_RPC_SYSTEM,
} from '@opentelemetry/semantic-conventions';
import { AWS_ATTRIBUTE_KEYS } from './aws-attribute-keys';
import * as SQL_DIALECT_KEYWORDS_JSON from './configuration/sql_dialect_keywords.json';

/** Utility class designed to support shared logic across AWS Span Processors. */
export class AwsSpanProcessingUtil {
  // Default attribute values if no valid span attribute value is identified
  static UNKNOWN_SERVICE: string = 'UnknownService';
  static UNKNOWN_OPERATION: string = 'UnknownOperation';
  static UNKNOWN_REMOTE_SERVICE: string = 'UnknownRemoteService';
  static UNKNOWN_REMOTE_OPERATION: string = 'UnknownRemoteOperation';
  static INTERNAL_OPERATION: string = 'InternalOperation';
  static LOCAL_ROOT: string = 'LOCAL_ROOT';
  static SQS_RECEIVE_MESSAGE_SPAN_NAME: string = 'Sqs.ReceiveMessage';
  static AWS_SDK_INSTRUMENTATION_SCOPE_PREFIX: string = 'io.opentelemetry.aws-sdk-';

  // Max keyword length supported by parsing into remote_operation from DB_STATEMENT.
  // The current longest command word is DATETIME_INTERVAL_PRECISION at 27 characters.
  // If we add a longer keyword to the sql dialect keyword list, need to update the constant below.
  static MAX_KEYWORD_LENGTH: number = 27;
  static SQL_DIALECT_PATTERN = '^(?:' + AwsSpanProcessingUtil.getDialectKeywords().join('|') + ')\\b';

  static getDialectKeywords(): string[] {
    return SQL_DIALECT_KEYWORDS_JSON.keywords;
  }

  /**
   * Ingress operation (i.e. operation for Server and Consumer spans) will be generated from
   * "http.method + http.target/with the first API path parameter" if the default span name equals
   * null, UnknownOperation or http.method value.
   */
  static getIngressOperation(span: ReadableSpan): string {
    let operation: string = span.name;
    if (AwsSpanProcessingUtil.shouldUseInternalOperation(span)) {
      operation = AwsSpanProcessingUtil.INTERNAL_OPERATION;
    } else if (!AwsSpanProcessingUtil.isValidOperation(span, operation)) {
      operation = AwsSpanProcessingUtil.generateIngressOperation(span);
    }
    return operation;
  }

  static getEgressOperation(span: ReadableSpan): string | undefined {
    if (AwsSpanProcessingUtil.shouldUseInternalOperation(span)) {
      return AwsSpanProcessingUtil.INTERNAL_OPERATION;
    } else {
      const awsLocalOperation: AttributeValue | undefined = span.attributes[AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION];
      return awsLocalOperation === undefined ? undefined : awsLocalOperation.toString();
    }
  }

  /**
   * Extract the first part from API http target if it exists
   *
   * @param httpTarget http request target string value. Eg, /payment/1234
   * @return the first part from the http target. Eg, /payment
   */
  static extractAPIPathValue(httpTarget: string): string {
    if (httpTarget == null || httpTarget === '') {
      return '/';
    }
    const paths: string[] = httpTarget.split('/');
    if (paths.length > 1) {
      return '/' + paths[1];
    }
    return '/';
  }

  static isKeyPresent(span: ReadableSpan, key: string): boolean {
    return span.attributes[key] !== undefined;
  }

  static isAwsSDKSpan(span: ReadableSpan): boolean {
    const rpcSystem: AttributeValue | undefined = span.attributes[SEMATTRS_RPC_SYSTEM];

    if (rpcSystem === undefined) {
      return false;
    }

    // https://opentelemetry.io/docs/specs/otel/trace/semantic_conventions/instrumentation/aws-sdk/#common-attributes
    return 'aws-api' === rpcSystem;
  }

  static shouldGenerateServiceMetricAttributes(span: ReadableSpan): boolean {
    return (
      (AwsSpanProcessingUtil.isLocalRoot(span) && !AwsSpanProcessingUtil.isSqsReceiveMessageConsumerSpan(span)) ||
      SpanKind.SERVER === span.kind
    );
  }

  static shouldGenerateDependencyMetricAttributes(span: ReadableSpan): boolean {
    // Divergence from Java/Python
    // In OTel JS, the AWS SDK instrumentation creates two Client Spans, one for AWS SDK,
    // and another for the underlying HTTP Client used by the SDK. The following code block
    // ensures that dependency metrics are not generated for direct descendent of AWS SDK Spans.
    const isAwsSdkDescendent: AttributeValue | undefined = span.attributes[AWS_ATTRIBUTE_KEYS.AWS_SDK_DESCENDANT];
    if (isAwsSdkDescendent !== undefined && isAwsSdkDescendent === 'true') {
      return false;
    }

    return (
      SpanKind.CLIENT === span.kind ||
      SpanKind.PRODUCER === span.kind ||
      (AwsSpanProcessingUtil.isDependencyConsumerSpan(span) &&
        !AwsSpanProcessingUtil.isSqsReceiveMessageConsumerSpan(span))
    );
  }

  static isConsumerProcessSpan(spanData: ReadableSpan): boolean {
    const messagingOperation: AttributeValue | undefined = spanData.attributes[SEMATTRS_MESSAGING_OPERATION];
    if (messagingOperation === undefined) {
      return false;
    }

    return SpanKind.CONSUMER === spanData.kind && MessagingOperationValues.PROCESS === messagingOperation;
  }

  // Any spans that are Local Roots and also not SERVER should have aws.local.operation renamed to
  // InternalOperation.
  static shouldUseInternalOperation(span: ReadableSpan): boolean {
    return AwsSpanProcessingUtil.isLocalRoot(span) && SpanKind.SERVER !== span.kind;
  }

  // A span is a local root if it has no parent or if the parent is remote. This function checks the
  // parent context and returns true if it is a local root.
  static isLocalRoot(spanData: ReadableSpan): boolean {
    // Workaround implemented for this function as parent span context is not obtainable.
    // This isLocalRoot value is precalculated in AttributePropagatingSpanProcessor, which
    // is started before the other processors (e.g. AwsSpanMetricsProcessor)
    // Thus this function is implemented differently than in Java/Python
    const isLocalRoot: AttributeValue | undefined = spanData.attributes[AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT];
    if (isLocalRoot === undefined) {
      // isLocalRoot should be precalculated, this code block should not be entered
      diag.debug('isLocalRoot for span has not been precalculated. Assuming span is Local Root Span.');
      return true;
    }
    return isLocalRoot as boolean;
  }

  // To identify the SQS consumer spans produced by AWS SDK instrumentation
  private static isSqsReceiveMessageConsumerSpan(spanData: ReadableSpan): boolean {
    const spanName: string = spanData.name;
    const spanKind: SpanKind = spanData.kind;
    const messagingOperation: AttributeValue | undefined = spanData.attributes[SEMATTRS_MESSAGING_OPERATION];

    const instrumentationLibrary: InstrumentationLibrary = spanData.instrumentationLibrary;

    return (
      AwsSpanProcessingUtil.SQS_RECEIVE_MESSAGE_SPAN_NAME.toLowerCase() === spanName.toLowerCase() &&
      SpanKind.CONSUMER === spanKind &&
      instrumentationLibrary != null &&
      instrumentationLibrary.name.startsWith(AwsSpanProcessingUtil.AWS_SDK_INSTRUMENTATION_SCOPE_PREFIX) &&
      (messagingOperation === undefined || messagingOperation === MessagingOperationValues.PROCESS)
    );
  }

  private static isDependencyConsumerSpan(span: ReadableSpan): boolean {
    if (SpanKind.CONSUMER !== span.kind) {
      return false;
    } else if (AwsSpanProcessingUtil.isConsumerProcessSpan(span)) {
      if (AwsSpanProcessingUtil.isLocalRoot(span)) {
        return true;
      }
      const parentSpanKind: AttributeValue | undefined =
        span.attributes[AWS_ATTRIBUTE_KEYS.AWS_CONSUMER_PARENT_SPAN_KIND];

      return SpanKind[SpanKind.CONSUMER] !== parentSpanKind;
    }
    return true;
  }

  /**
   * When Span name is null, UnknownOperation or HttpMethod value, it will be treated as invalid
   * local operation value that needs to be further processed
   */
  private static isValidOperation(span: ReadableSpan, operation: string): boolean {
    if (operation == null || operation === AwsSpanProcessingUtil.UNKNOWN_OPERATION) {
      return false;
    }
    if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_HTTP_METHOD)) {
      const httpMethod: AttributeValue | undefined = span.attributes[SEMATTRS_HTTP_METHOD];
      return operation !== httpMethod;
    }
    return true;
  }

  /**
   * When span name is not meaningful(null, unknown or http_method value) as operation name for http
   * use cases. Will try to extract the operation name from http target string
   */
  private static generateIngressOperation(span: ReadableSpan): string {
    let operation: string = AwsSpanProcessingUtil.UNKNOWN_OPERATION;
    if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_HTTP_TARGET)) {
      const httpTarget: AttributeValue | undefined = span.attributes[SEMATTRS_HTTP_TARGET];
      // get the first part from API path string as operation value
      // the more levels/parts we get from API path the higher chance for getting high cardinality
      // data
      if (httpTarget != null) {
        operation = AwsSpanProcessingUtil.extractAPIPathValue(httpTarget.toString());
        if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_HTTP_METHOD)) {
          const httpMethod: AttributeValue | undefined = span.attributes[SEMATTRS_HTTP_METHOD];
          if (httpMethod != null) {
            operation = httpMethod.toString() + ' ' + operation;
          }
        }
      }
    }
    return operation;
  }

  // Check if the current Span adheres to database semantic conventions
  static isDBSpan(span: ReadableSpan): boolean {
    return (
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_DB_SYSTEM) ||
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_DB_OPERATION) ||
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_DB_STATEMENT)
    );
  }

  // Divergence from Java/Python
  static setIsLocalRootInformation(span: Span, parentContext: Context): void {
    const parentSpanContext: SpanContext | undefined = trace.getSpanContext(parentContext);
    const isParentSpanContextValid: boolean = parentSpanContext !== undefined && isSpanContextValid(parentSpanContext);
    const isParentSpanRemote: boolean = parentSpanContext !== undefined && parentSpanContext.isRemote === true;

    const isLocalRoot: boolean = span.parentSpanId === undefined || !isParentSpanContextValid || isParentSpanRemote;
    span.setAttribute(AWS_ATTRIBUTE_KEYS.AWS_IS_LOCAL_ROOT, isLocalRoot);
  }
}
