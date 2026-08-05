// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { PresignedAwsUrl } from './presigned-aws-url';
import { PresignedAwsUrlParser } from './presigned-aws-url-parser';
import { S3PresignedUrlAttributor } from './s3-presigned-url-attributor';

export interface RemoteResource {
  type: string;
  identifier: string;
}

/**
 * The Application Signals remote attribution derived from a presigned AWS URL. A resource is present
 * only when the service-specific attributor can identify it confidently.
 */
export interface PresignedUrlAttribution {
  remoteService: string;
  remoteOperation: string;
  remoteResource?: RemoteResource;
}

/**
 * Derives Application Signals attribution from a presigned AWS URL.
 *
 * Parses the span's URL once, then lets each service-specific attributor try to claim it based on
 * the endpoint hostname (the signing service cannot be read from the credential scope because it is
 * redacted). If none claims the URL — custom CNAMEs, unknown endpoints, or non-presigned URLs —
 * attribution falls back to the existing behavior.
 */
export class PresignedUrlAttributor {
  static attribute(span: ReadableSpan): PresignedUrlAttribution | undefined {
    const presignedAwsUrl = PresignedAwsUrlParser.parseSpan(span);
    if (presignedAwsUrl === undefined) {
      return undefined;
    }
    return PresignedUrlAttributor.attributeUrl(presignedAwsUrl);
  }

  private static attributeUrl(presignedAwsUrl: PresignedAwsUrl): PresignedUrlAttribution | undefined {
    // Only S3 is supported today. Additional services (e.g. SQS, execute-api) can be tried here in
    // turn, each claiming the URL only when it recognizes the endpoint.
    return S3PresignedUrlAttributor.attribute(presignedAwsUrl);
  }
}
