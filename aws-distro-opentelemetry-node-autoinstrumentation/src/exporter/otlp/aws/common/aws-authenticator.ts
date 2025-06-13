// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { diag } from '@opentelemetry/api';
import { getNodeVersion } from '../../../../utils';
let SignatureV4: any;
let HttpRequest: any;
let defaultProvider: any;
let Sha256: any;

let dependenciesLoaded = false;

if (getNodeVersion() >= 16) {
  try {
    defaultProvider = require('@aws-sdk/credential-provider-node').defaultProvider;
    Sha256 = require('@aws-crypto/sha256-js').Sha256;
    SignatureV4 = require('@smithy/signature-v4').SignatureV4;
    HttpRequest = require('@smithy/protocol-http').HttpRequest;
    dependenciesLoaded = true;
  } catch (error) {
    diag.error(`Failed to load required AWS dependency for SigV4 Signing: ${error}`);
  }
} else {
  diag.error('SigV4 signing requires at least Node major version 16');
}

export class AwsAuthenticator {
  private region: string;
  private service: string;

  constructor(region: string, service: string) {
    this.region = region;
    this.service = service;
  }

  public async authenticate(endpoint: string, headers: Record<string, string>, serializedData: Uint8Array | undefined) {
    // Only do SigV4 Signing if the required dependencies are installed.
    if (dependenciesLoaded) {
      const url = new URL(endpoint);

      if (serializedData === undefined) {
        diag.error('Given serialized data is undefined. Not authenticating.');
        return headers;
      }

      const cleanedHeaders = this.removeSigV4Headers(headers);

      const request = new HttpRequest({
        method: 'POST',
        protocol: 'https',
        hostname: url.hostname,
        path: url.pathname,
        body: serializedData,
        headers: {
          ...cleanedHeaders,
          host: url.hostname,
        },
      });

      try {
        const signer = new SignatureV4({
          credentials: defaultProvider(),
          region: this.region,
          service: this.service,
          sha256: Sha256,
        });

        const signedRequest = await signer.sign(request);

        return signedRequest.headers;
      } catch (exception) {
        diag.debug(
          `Failed to sign/authenticate the given exported Span request to OTLP XRay endpoint with error: ${exception}`
        );
      }
    }

    return headers;
  }

  // Cleans up Sigv4 from headers to avoid accidentally copying them to the new headers
  private removeSigV4Headers(headers: Record<string, string>) {
    const newHeaders: Record<string, string> = {};
    const sigV4Headers = ['x-amz-date', 'authorization', 'x-amz-content-sha256', 'x-amz-security-token'];

    for (const key in headers) {
      if (!sigV4Headers.includes(key.toLowerCase())) {
        newHeaders[key] = headers[key];
      }
    }
    return newHeaders;
  }
}
