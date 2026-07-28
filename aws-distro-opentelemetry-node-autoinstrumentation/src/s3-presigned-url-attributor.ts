// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AwsSpanProcessingUtil } from './aws-span-processing-util';
import { PresignedAwsUrl } from './presigned-aws-url';
import { PresignedUrlAttribution, RemoteResource } from './presigned-url-attributor';

const NORMALIZED_S3_SERVICE_NAME: string = 'AWS::S3';
const S3_BUCKET_RESOURCE_TYPE: string = NORMALIZED_S3_SERVICE_NAME + '::Bucket';

// Standard S3 endpoint host forms, including global, regional, legacy regional, dual-stack,
// transfer acceleration, FIPS (incl. FIPS dual-stack), and China (.com.cn). The optional segment
// after "s3" covers the mutually exclusive endpoint styles.
//
// The legacy "-<label>" alternative is intentionally broad: besides legacy regional hosts
// (s3-us-west-2) it also matches other s3-prefixed AWS hosts such as s3-website-<region>. This is
// accepted deliberately as low risk — all such hosts are S3-owned domains anchored to
// amazonaws.com, and presigned object requests do not target website/other endpoints.
// https://docs.aws.amazon.com/general/latest/gr/s3.html
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/dual-stack-endpoints.html
const S3_ENDPOINT_SUFFIX: string =
  's3(?:' +
  '\\.(?:dualstack\\.)?[a-z0-9-]+' + // s3.<region> | s3.dualstack.<region>
  '|-fips(?:\\.dualstack)?\\.[a-z0-9-]+' + // s3-fips.<region> | s3-fips.dualstack.<region>
  '|-accelerate(?:\\.dualstack)?' + // s3-accelerate | s3-accelerate.dualstack
  '|-[a-z0-9-]+' + // s3-<region> (legacy regional)
  ')?\\.amazonaws\\.com(?:\\.cn)?';
// Cannot define type for regex variables
// eslint-disable-next-line @typescript-eslint/typedef
const VIRTUAL_HOSTED_S3_ENDPOINT = new RegExp('^(.+)\\.' + S3_ENDPOINT_SUFFIX + '$', 'i');
// eslint-disable-next-line @typescript-eslint/typedef
const PATH_STYLE_S3_ENDPOINT = new RegExp('^' + S3_ENDPOINT_SUFFIX + '$', 'i');

/**
 * Derives `AWS::S3` attribution from a presigned S3 URL by recognizing S3 endpoint hostnames.
 *
 * Because the signing service cannot be read from the (redacted) credential scope, S3 is identified
 * purely from the endpoint host. Only the standard virtual-hosted and path-style S3 endpoint forms
 * are recognized. Anything else — custom CNAMEs, access points, unknown endpoints — fails closed
 * (returns undefined) so we never mis-attribute a non-S3 or unverifiable request.
 *
 * The remote operation is derived from the HTTP method, whether an object key is present (bucket- vs
 * object-level), and the S3 subresource/multipart query parameters. Operation names follow the S3
 * REST API. References:
 *
 * - Endpoints: https://docs.aws.amazon.com/general/latest/gr/s3.html
 * - Virtual-hosted vs path-style:
 *   https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html
 * - S3 REST API operations: https://docs.aws.amazon.com/AmazonS3/latest/API/API_Operations.html
 */
export class S3PresignedUrlAttributor {
  static attribute(presignedAwsUrl: PresignedAwsUrl): PresignedUrlAttribution | undefined {
    const host = presignedAwsUrl.getHost();
    const pathStyle = PATH_STYLE_S3_ENDPOINT.test(host);

    let bucket: string | undefined;
    if (pathStyle) {
      bucket = getPathStyleBucket(presignedAwsUrl);
    } else {
      bucket = getVirtualHostedStyleBucket(host);
      if (bucket === undefined) {
        // Not a recognized S3 endpoint (custom CNAME, access point, unknown host). Fail closed: the
        // signing service cannot be recovered from a redacted credential scope.
        return undefined;
      }
    }

    const remoteResource: RemoteResource | undefined =
      bucket === undefined ? undefined : { type: S3_BUCKET_RESOURCE_TYPE, identifier: bucket };

    return {
      remoteService: NORMALIZED_S3_SERVICE_NAME,
      remoteOperation: getRemoteOperation(presignedAwsUrl, pathStyle),
      remoteResource: remoteResource,
    };
  }
}

function getRemoteOperation(presignedAwsUrl: PresignedAwsUrl, pathStyle: boolean): string {
  const httpMethod = presignedAwsUrl.getHttpMethod();
  if (httpMethod === undefined) {
    return AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION;
  }

  const normalizedMethod = httpMethod.toUpperCase();
  const hasObjectKeyPresent = hasObjectKey(presignedAwsUrl, pathStyle);

  // ListObjectsV2 is a bucket-level GET (no object key).
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
  if (
    normalizedMethod === 'GET' &&
    !hasObjectKeyPresent &&
    presignedAwsUrl.getFirstQueryParameterValue('list-type') === '2'
  ) {
    return 'ListObjectsV2';
  }

  // S3 multipart REST API operations.
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html
  if (presignedAwsUrl.getFirstQueryParameterValue('uploadId') !== undefined) {
    if (normalizedMethod === 'PUT' && presignedAwsUrl.getFirstQueryParameterValue('partNumber') !== undefined) {
      return 'UploadPart';
    }
    if (normalizedMethod === 'GET') {
      return 'ListParts';
    }
    if (normalizedMethod === 'POST') {
      return 'CompleteMultipartUpload';
    }
    if (normalizedMethod === 'DELETE') {
      return 'AbortMultipartUpload';
    }
  }

  if (presignedAwsUrl.getFirstQueryParameterValue('uploads') !== undefined) {
    if (normalizedMethod === 'POST' && hasObjectKeyPresent) {
      return 'CreateMultipartUpload';
    }
    if (normalizedMethod === 'GET' && !hasObjectKeyPresent) {
      return 'ListMultipartUploads';
    }
  }

  // Subresource operations selected by a query parameter. They are object-level when an object key is
  // present and bucket-level otherwise.
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectAcl.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectTagging.html
  if (presignedAwsUrl.getFirstQueryParameterValue('acl') !== undefined) {
    if (normalizedMethod === 'GET') {
      return hasObjectKeyPresent ? 'GetObjectAcl' : 'GetBucketAcl';
    }
    if (normalizedMethod === 'PUT') {
      return hasObjectKeyPresent ? 'PutObjectAcl' : 'PutBucketAcl';
    }
  }
  if (presignedAwsUrl.getFirstQueryParameterValue('tagging') !== undefined) {
    if (normalizedMethod === 'GET') {
      return hasObjectKeyPresent ? 'GetObjectTagging' : 'GetBucketTagging';
    }
    if (normalizedMethod === 'PUT') {
      return hasObjectKeyPresent ? 'PutObjectTagging' : 'PutBucketTagging';
    }
    if (normalizedMethod === 'DELETE') {
      return hasObjectKeyPresent ? 'DeleteObjectTagging' : 'DeleteBucketTagging';
    }
  }

  // Object-only subresources. These operate on an object, so they require an object key.
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectRetention.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectLegalHold.html
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectTorrent.html
  if (hasObjectKeyPresent) {
    if (presignedAwsUrl.getFirstQueryParameterValue('retention') !== undefined) {
      if (normalizedMethod === 'GET') {
        return 'GetObjectRetention';
      }
      if (normalizedMethod === 'PUT') {
        return 'PutObjectRetention';
      }
    }
    if (presignedAwsUrl.getFirstQueryParameterValue('legal-hold') !== undefined) {
      if (normalizedMethod === 'GET') {
        return 'GetObjectLegalHold';
      }
      if (normalizedMethod === 'PUT') {
        return 'PutObjectLegalHold';
      }
    }
    if (normalizedMethod === 'GET' && presignedAwsUrl.getFirstQueryParameterValue('torrent') !== undefined) {
      return 'GetObjectTorrent';
    }
  }

  if (!hasObjectKeyPresent) {
    return AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION;
  }

  switch (normalizedMethod) {
    case 'GET':
      return 'GetObject';
    case 'HEAD':
      return 'HeadObject';
    case 'PUT':
      return 'PutObject';
    case 'DELETE':
      return 'DeleteObject';
    default:
      return AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION;
  }
}

function hasObjectKey(presignedAwsUrl: PresignedAwsUrl, pathStyle: boolean): boolean {
  const pathSegments = getPathSegments(presignedAwsUrl.getPath());
  if (pathStyle) {
    // Path-style URLs carry the bucket as the first path segment, so an object key requires a second
    // segment.
    return pathSegments.length > 1;
  }
  return pathSegments.length > 0;
}

function getPathStyleBucket(presignedAwsUrl: PresignedAwsUrl): string | undefined {
  const pathSegments = getPathSegments(presignedAwsUrl.getPath());
  if (pathSegments.length === 0) {
    return undefined;
  }
  return pathSegments[0];
}

function getVirtualHostedStyleBucket(host: string): string | undefined {
  const match = VIRTUAL_HOSTED_S3_ENDPOINT.exec(host);
  if (match === null) {
    return undefined;
  }
  return match[1];
}

function getPathSegments(path: string): string[] {
  const normalizedPath = (path ? path : '').replace(/^\/+/, '');
  if (normalizedPath === '') {
    return [];
  }
  // Drop empty segments so a trailing slash (e.g. path-style "/bucket/") is not misread as an
  // object key. Java's String.split already discards trailing empties; JS's String.split does not.
  return normalizedPath.split('/').filter(segment => segment !== '');
}
