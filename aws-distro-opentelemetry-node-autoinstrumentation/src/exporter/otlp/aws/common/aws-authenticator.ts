// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { diag } from '@opentelemetry/api';
import { getNodeVersion } from '../../../../utils';
let SignatureV4: any;
let HttpRequest: any;
let defaultProvider: any;
let Sha256: any;
let loadConfig: any;
let NODE_REGION_CONFIG_OPTIONS: any;
let NODE_REGION_CONFIG_FILE_OPTIONS: any;

let dependenciesLoaded = false;
let regionConfigLoaded = false;

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

  // Loaded separately because they are only needed to find a signing region in the AWS config files
  // when nothing else names one, so their absence must not disable signing as a whole.
  try {
    loadConfig = require('@smithy/node-config-provider').loadConfig;
    ({ NODE_REGION_CONFIG_OPTIONS, NODE_REGION_CONFIG_FILE_OPTIONS } = require('@smithy/config-resolver'));
    regionConfigLoaded = true;
  } catch (error) {
    diag.debug(`AWS region configuration lookup is unavailable for SigV4 signing: ${error}`);
  }
} else {
  diag.error('SigV4 signing requires at least Node major version 16');
}

// See: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
export const AUTHORIZATION_HEADER = 'authorization';
export const X_AMZ_DATE_HEADER = 'x-amz-date';
export const X_AMZ_SECURITY_TOKEN_HEADER = 'x-amz-security-token';
export const X_AMZ_CONTENT_SHA256_HEADER = 'x-amz-content-sha256';

/**
 * A signing region, either known up front or looked up when the first request is signed.
 */
export type SigV4Region = string | (() => Promise<string>);

// Matches a region label anywhere within a recognized AWS domain, so that VPC endpoint, OSIS pipeline
// and other service-specific hostnames resolve as well as the standard `<service>.<region>.<suffix>`
// form. The suffixes are the AWS partitions, matching the Java and Python distributions.
const AWS_ENDPOINT_REGION_PATTERN = new RegExp(
  '^(?:[a-z0-9-]+\\.)*([a-z]+(?:-[a-z]+)+-\\d+)(?:\\.[a-z0-9-]+)*\\.' +
    '(?:amazonaws\\.com(?:\\.cn)?|api\\.aws|c2s\\.ic\\.gov|sc2s\\.sgov\\.gov|cloud\\.adc-e\\.uk|csp\\.hci\\.ic\\.gov)$',
  'i'
);

/**
 * Resolves a signing region without any I/O: AWS_REGION, then AWS_DEFAULT_REGION, then a region
 * found in the endpoint hostname. Returns undefined when none of these name one, so the caller can
 * fall back to {@link loadSigV4RegionFromAwsConfig}.
 */
export function resolveSigV4Region(endpoint: string): string | undefined {
  const fromEnv = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (fromEnv) {
    return fromEnv;
  }

  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return undefined;
  }

  return AWS_ENDPOINT_REGION_PATTERN.exec(hostname)?.[1]?.toLowerCase();
}

/**
 * Looks up the signing region from the AWS SDK's region chain, which includes the shared AWS config
 * file. That lookup is asynchronous, so it cannot run while exporters are constructed at startup and
 * instead runs when the first request is signed. The result is cached, including a failure, which is
 * logged once with the settings that would fix it.
 */
export function loadSigV4RegionFromAwsConfig(): () => Promise<string> {
  let region: Promise<string> | undefined;

  return () => {
    region ??= (async () => {
      const resolved = regionConfigLoaded
        ? await loadConfig(NODE_REGION_CONFIG_OPTIONS, NODE_REGION_CONFIG_FILE_OPTIONS)().catch(() => undefined)
        : undefined;

      if (!resolved) {
        const message =
          'otlp/sigv4 could not determine an AWS signing region. Set AWS_REGION or AWS_DEFAULT_REGION, use ' +
          'an endpoint whose hostname includes the region, or set a region in the AWS config file.';
        diag.error(message);
        throw new Error(message);
      }

      return resolved;
    })();

    return region;
  };
}

export class AwsAuthenticator {
  private endpoint: URL;
  private region: SigV4Region;
  private service: string;

  /**
   * @param region - the signing region. When omitted it is read from the endpoint hostname, which
   *   callers have already validated as a standard AWS OTLP endpoint with isAwsOtlpEndpoint.
   */
  constructor(endpoint: string, service: string, region?: SigV4Region) {
    // Callers either pre-validate the endpoint with isAwsOtlpEndpoint or parse it before
    // constructing an exporter, so new URL() will not throw.
    this.endpoint = new URL(endpoint);
    this.region = region ?? endpoint.split('.')[1];
    this.service = service;
  }

  public async authenticate(headers: Record<string, string>, serializedData: Uint8Array | undefined) {
    // Only do SigV4 Signing if the required dependencies are installed.
    if (dependenciesLoaded && serializedData) {
      const cleanedHeaders = this.removeSigV4Headers(headers);

      const request = new HttpRequest({
        method: 'POST',
        protocol: 'https',
        hostname: this.endpoint.hostname,
        path: this.endpoint.pathname,
        body: serializedData,
        headers: {
          ...cleanedHeaders,
          // `host` includes a non-default port, matching the Host header actually sent. Standard AWS
          // OTLP endpoints never carry one, but an endpoint chosen through otlp/sigv4 may.
          host: this.endpoint.host,
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
        diag.debug(`Failed to sign/authenticate the given export request with error: ${exception}`);
        return undefined;
      }
    }

    diag.debug('No serialized data provided. Not authenticating.');
    return undefined;
  }

  // Cleans up Sigv4 from headers to avoid accidentally copying them to the new headers
  private removeSigV4Headers(headers: Record<string, string>) {
    const newHeaders: Record<string, string> = {};
    const sigv4Headers = [
      AUTHORIZATION_HEADER,
      X_AMZ_CONTENT_SHA256_HEADER,
      X_AMZ_DATE_HEADER,
      // Previously X_AMZ_CONTENT_SHA256_HEADER was listed twice and the security token was missing,
      // so a stale token could survive into the next signed request. The signer overwrites it
      // whenever the credentials carry a session token, which kept this latent.
      X_AMZ_SECURITY_TOKEN_HEADER,
    ];

    for (const key in headers) {
      if (!sigv4Headers.includes(key.toLowerCase())) {
        newHeaders[key] = headers[key];
      }
    }
    return newHeaders;
  }
}
