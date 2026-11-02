// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A parsed SigV4 presigned AWS URL.
 *
 * Carries the request context needed for attribution that a plain parsed URL cannot express: the
 * HTTP method (which comes from the span, not the URL) and the parsed query parameters. The host
 * and path come from the URL itself.
 *
 * The signing service is intentionally not carried here: it is derived from the SigV4 credential
 * scope, which URL sanitization redacts. Service identity is instead determined from the endpoint
 * hostname by the service-specific attributor.
 */
export class PresignedAwsUrl {
  private readonly _host: string;
  private readonly _path: string;
  private readonly _httpMethod: string | undefined;
  private readonly _queryParameters: Map<string, string[]>;

  constructor(host: string, path: string, httpMethod: string | undefined, queryParameters: Map<string, string[]>) {
    this._host = host;
    this._path = path ? path : '/';
    this._httpMethod = httpMethod;
    this._queryParameters = queryParameters;
  }

  getHttpMethod(): string | undefined {
    return this._httpMethod;
  }

  getHost(): string {
    return this._host;
  }

  getPath(): string {
    return this._path;
  }

  getFirstQueryParameterValue(name: string): string | undefined {
    const values = this._queryParameters.get(name);
    if (values === undefined || values.length === 0) {
      return undefined;
    }
    return values[0];
  }
}
