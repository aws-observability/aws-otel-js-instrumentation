// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes } from '@opentelemetry/api';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const ENV_ADOT_REDACT_SPAN_ATTRIBUTES = 'ADOT_REDACT_SPAN_ATTRIBUTES';
export const REDACTED_VALUE = 'REDACTED';

/**
 * Redacts configured attributes on completed spans, their events, and their links.
 *
 * Attribute names can be supplied to the constructor or through the
 * ADOT_REDACT_SPAN_ATTRIBUTES environment variable as a comma-separated list.
 * Each entry can be an exact attribute name or contain * wildcards. Matching
 * attribute values are replaced with REDACTED in place while attribute names
 * and non-matching values remain unchanged.
 *
 * Redact several exact attributes, every attribute beginning with
 * http.request., and matching GenAI content attributes:
 *
 * ADOT_REDACT_SPAN_ATTRIBUTES=user.email,request.body,db.statement,http.request.*,gen_ai.*.content
 *
 * Redact every span, span event, and span link attribute:
 *
 * ADOT_REDACT_SPAN_ATTRIBUTES=*
 */
export class AttributeRedactingSpanProcessor implements SpanProcessor {
  public readonly attributesToRedact: string[];
  private readonly compiledPatterns: RegExp[];

  public constructor(attributesToRedact?: string[]) {
    this.attributesToRedact =
      attributesToRedact && attributesToRedact.length > 0
        ? [...attributesToRedact]
        : (process.env[ENV_ADOT_REDACT_SPAN_ATTRIBUTES] ?? '')
            .split(',')
            .map(attribute => attribute.trim())
            .filter(attribute => attribute.length > 0);
    this.compiledPatterns = this.attributesToRedact.map(attribute => {
      const pattern = attribute.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${pattern}$`);
    });
  }

  public onStart(): void {}

  public onEnd(span: ReadableSpan): void {
    if (this.attributesToRedact.length === 0) {
      return;
    }

    this.redactAttributes(span.attributes);
    span.events.forEach(event => this.redactAttributes(event.attributes));
    span.links.forEach(link => this.redactAttributes(link.attributes));
  }

  private redactAttributes(attributes?: Attributes): void {
    if (!attributes) {
      return;
    }

    Object.keys(attributes).forEach(attributeName => {
      if (this.shouldRedact(attributeName)) {
        attributes[attributeName] = REDACTED_VALUE;
      }
    });
  }

  private shouldRedact(attributeName: string): boolean {
    return this.compiledPatterns.some(pattern => pattern.test(attributeName));
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
