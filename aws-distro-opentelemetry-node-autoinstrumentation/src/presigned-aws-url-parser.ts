// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue } from '@opentelemetry/api';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { PresignedAwsUrl } from './presigned-aws-url';

// SigV4 query-string authentication parameters.
// https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
const X_AMZ_ALGORITHM: string = 'X-Amz-Algorithm';
const X_AMZ_CREDENTIAL: string = 'X-Amz-Credential';
const X_AMZ_SIGNATURE: string = 'X-Amz-Signature';
const X_AMZ_DATE: string = 'X-Amz-Date';
const X_AMZ_EXPIRES: string = 'X-Amz-Expires';
const X_AMZ_SIGNED_HEADERS: string = 'X-Amz-SignedHeaders';
const SIGV4_ALGORITHMS: Set<string> = new Set(['AWS4-HMAC-SHA256', 'AWS4-ECDSA-P256-SHA256']);

// URL attribute keys, stable then legacy.
const ATTR_URL_FULL: string = 'url.full';
const ATTR_HTTP_URL: string = 'http.url';
const ATTR_HTTP_REQUEST_METHOD: string = 'http.request.method';
const ATTR_HTTP_METHOD: string = 'http.method';

/**
 * Recognizes a SigV4/SigV4a presigned AWS URL from a span's URL.
 *
 * Detection relies only on non-sensitive signals. A presigned (query-authenticated) request carries
 * all six SigV4 query parameters: `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Signature`,
 * `X-Amz-Date`, `X-Amz-Expires` and `X-Amz-SignedHeaders`. Of these, only the `X-Amz-Algorithm`
 * value is inspected (against an allowlist); `X-Amz-Credential` and `X-Amz-Signature` are required
 * to be present with a non-empty value but their values are never read, because URL sanitization
 * replaces them with `REDACTED` before metric attribution runs. `X-Amz-Date`, `X-Amz-Expires` and
 * `X-Amz-SignedHeaders` are never redacted, so requiring them provides cheap verification. The
 * signing service is identified downstream from the endpoint hostname, not from the credential
 * scope.
 */
export class PresignedAwsUrlParser {
  static parseSpan(span: ReadableSpan): PresignedAwsUrl | undefined {
    // URL: stable `url.full` first, then legacy `http.url`.
    const url = PresignedAwsUrlParser.getStringAttribute(span, ATTR_URL_FULL, ATTR_HTTP_URL);
    // Method: stable `http.request.method` first, then legacy `http.method`.
    const httpMethod = PresignedAwsUrlParser.getStringAttribute(span, ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_METHOD);
    return PresignedAwsUrlParser.parse(url, httpMethod);
  }

  static parse(url: string | undefined, httpMethod: string | undefined): PresignedAwsUrl | undefined {
    if (!url) {
      return undefined;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e: unknown) {
      return undefined;
    }

    if (!parsed.hostname) {
      return undefined;
    }

    // `URL.search` includes the leading '?'; strip it before splitting on '&'.
    const queryParameters = parseQueryParameters(parsed.search.replace(/^\?/, ''));
    if (!isPresignedSigV4Request(queryParameters)) {
      return undefined;
    }

    return new PresignedAwsUrl(parsed.hostname, parsed.pathname, httpMethod, queryParameters);
  }

  private static getStringAttribute(span: ReadableSpan, primaryKey: string, fallbackKey: string): string | undefined {
    const primary: AttributeValue | undefined = span.attributes[primaryKey];
    if (typeof primary === 'string') {
      return primary;
    }
    const fallback: AttributeValue | undefined = span.attributes[fallbackKey];
    if (typeof fallback === 'string') {
      return fallback;
    }
    return undefined;
  }
}

/**
 * A request is a presigned SigV4/SigV4a request when it carries the signing algorithm, credential
 * and signature parameters together with the presigned query parameters that AWS always includes
 * (`X-Amz-Date`, `X-Amz-Expires`, `X-Amz-SignedHeaders`). Only the algorithm value is inspected
 * against an allowlist; the credential and signature must be present with a value but the value
 * itself is not read, because sanitization replaces it with a non-empty `REDACTED`. Empty values are
 * rejected as malformed.
 */
function isPresignedSigV4Request(queryParameters: Map<string, string[]>): boolean {
  const algorithm = getFirstValue(queryParameters, X_AMZ_ALGORITHM);
  return (
    algorithm !== undefined &&
    SIGV4_ALGORITHMS.has(algorithm) &&
    hasNonEmptyValue(queryParameters, X_AMZ_CREDENTIAL) &&
    hasNonEmptyValue(queryParameters, X_AMZ_SIGNATURE) &&
    hasNonEmptyValue(queryParameters, X_AMZ_DATE) &&
    hasNonEmptyValue(queryParameters, X_AMZ_EXPIRES) &&
    hasNonEmptyValue(queryParameters, X_AMZ_SIGNED_HEADERS)
  );
}

function hasNonEmptyValue(queryParameters: Map<string, string[]>, name: string): boolean {
  const value = getFirstValue(queryParameters, name);
  return value !== undefined && value !== '';
}

function getFirstValue(queryParameters: Map<string, string[]>, name: string): string | undefined {
  const values = queryParameters.get(name);
  if (values === undefined || values.length === 0) {
    return undefined;
  }
  return values[0];
}

function parseQueryParameters(rawQuery: string): Map<string, string[]> {
  const queryParameters: Map<string, string[]> = new Map();
  if (!rawQuery) {
    return queryParameters;
  }

  for (const pair of rawQuery.split('&')) {
    const delimiterIndex = pair.indexOf('=');
    const name = delimiterIndex >= 0 ? pair.substring(0, delimiterIndex) : pair;
    const value = delimiterIndex >= 0 ? pair.substring(delimiterIndex + 1) : '';
    const decodedName = decode(name);
    const values = queryParameters.get(decodedName);
    if (values === undefined) {
      queryParameters.set(decodedName, [decode(value)]);
    } else {
      values.push(decode(value));
    }
  }
  return queryParameters;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (e: unknown) {
    // Malformed percent-encoding; keep the raw value rather than dropping the parameter, so the
    // presence-based checks still see it.
    return value;
  }
}
