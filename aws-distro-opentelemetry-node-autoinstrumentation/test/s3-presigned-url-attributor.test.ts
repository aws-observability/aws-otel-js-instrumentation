// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for S3PresignedUrlAttributor.
//
// S3 attribution is driven purely by the endpoint hostname (the signing service cannot be read from
// the redacted credential scope). Tests use realistic sanitized URLs (redacted credential and
// signature).

import { expect } from 'expect';
import { PresignedAwsUrl } from '../src/presigned-aws-url';
import { PresignedAwsUrlParser } from '../src/presigned-aws-url-parser';
import { PresignedUrlAttribution } from '../src/presigned-url-attributor';
import { S3PresignedUrlAttributor } from '../src/s3-presigned-url-attributor';

function presignedUrl(
  method: string | undefined,
  host: string,
  path: string,
  extraQueryParameters: string = ''
): PresignedAwsUrl | undefined {
  return PresignedAwsUrlParser.parse(
    'https://' +
      host +
      path +
      '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
      '&X-Amz-Credential=REDACTED' +
      '&X-Amz-Signature=REDACTED' +
      '&X-Amz-Date=20260710T120000Z' +
      '&X-Amz-Expires=3600' +
      '&X-Amz-SignedHeaders=host' +
      extraQueryParameters,
    method
  );
}

function attribute(url: PresignedAwsUrl | undefined): PresignedUrlAttribution {
  expect(url).not.toBeUndefined();
  const attribution = S3PresignedUrlAttributor.attribute(url!);
  expect(attribution).not.toBeUndefined();
  return attribution!;
}

describe('S3PresignedUrlAttributorTest', () => {
  it('resolvesBucketForEndpointVariant', () => {
    // host, path, expected bucket
    const cases: [string, string, string][] = [
      // Virtual-hosted style
      ['example-bucket.s3.amazonaws.com', '/object', 'example-bucket'],
      ['example-bucket.s3.us-west-2.amazonaws.com', '/object', 'example-bucket'],
      ['example-bucket.s3-us-west-2.amazonaws.com', '/object', 'example-bucket'],
      ['example.s3.bucket.s3.us-west-2.amazonaws.com', '/object', 'example.s3.bucket'],
      ['example-bucket.s3.cn-north-1.amazonaws.com.cn', '/object', 'example-bucket'],
      ['example-bucket.s3.dualstack.us-west-2.amazonaws.com', '/object', 'example-bucket'],
      ['example-bucket.s3-accelerate.amazonaws.com', '/object', 'example-bucket'],
      ['example-bucket.s3-accelerate.dualstack.amazonaws.com', '/object', 'example-bucket'],
      ['example-bucket.s3-fips.us-west-2.amazonaws.com', '/object', 'example-bucket'],
      ['example-bucket.s3-fips.dualstack.us-east-1.amazonaws.com', '/object', 'example-bucket'],
      // Path-style: bucket is the first path segment
      ['s3.amazonaws.com', '/example-bucket/object', 'example-bucket'],
      ['s3.us-west-2.amazonaws.com', '/example-bucket/object', 'example-bucket'],
      ['s3.cn-north-1.amazonaws.com.cn', '/example-bucket/object', 'example-bucket'],
      ['s3-fips.us-west-2.amazonaws.com', '/example-bucket/object', 'example-bucket'],
      ['s3-fips.dualstack.us-east-1.amazonaws.com', '/example-bucket/object', 'example-bucket'],
    ];
    for (const [host, path, expectedBucket] of cases) {
      const attribution = attribute(presignedUrl('GET', host, path));
      expect(attribution.remoteService).toEqual('AWS::S3');
      expect(attribution.remoteResource).not.toBeUndefined();
      expect(attribution.remoteResource!.type).toEqual('AWS::S3::Bucket');
      expect(attribution.remoteResource!.identifier).toEqual(expectedBucket);
    }
  });

  it('resolvesOperation', () => {
    // method, path, extra query params, expected operation
    const cases: [string, string, string, string][] = [
      ['GET', '/object', '', 'GetObject'],
      ['PUT', '/object', '', 'PutObject'],
      ['HEAD', '/object', '', 'HeadObject'],
      ['DELETE', '/object', '', 'DeleteObject'],
      ['PATCH', '/object', '', 'UnknownRemoteOperation'],
      // ListObjectsV2 is bucket-level only
      ['GET', '/', '&list-type=2', 'ListObjectsV2'],
      ['GET', '/object', '&list-type=2', 'GetObject'],
      ['PUT', '/object', '&list-type=2', 'PutObject'],
      // Multipart
      ['PUT', '/object', '&partNumber=1&uploadId=upload', 'UploadPart'],
      ['PUT', '/object', '&uploadId=upload', 'PutObject'],
      ['GET', '/object', '&uploadId=upload', 'ListParts'],
      ['POST', '/object', '&uploadId=upload', 'CompleteMultipartUpload'],
      ['DELETE', '/object', '&uploadId=upload', 'AbortMultipartUpload'],
      ['POST', '/object', '&uploads', 'CreateMultipartUpload'],
      ['GET', '/', '&uploads', 'ListMultipartUploads'],
      ['GET', '/object', '&uploads', 'GetObject'],
      // ACL / tagging (object- and bucket-level)
      ['GET', '/object', '&acl', 'GetObjectAcl'],
      ['PUT', '/object', '&acl', 'PutObjectAcl'],
      ['GET', '/', '&acl', 'GetBucketAcl'],
      ['PUT', '/', '&acl', 'PutBucketAcl'],
      ['GET', '/object', '&tagging', 'GetObjectTagging'],
      ['PUT', '/object', '&tagging', 'PutObjectTagging'],
      ['DELETE', '/object', '&tagging', 'DeleteObjectTagging'],
      ['GET', '/', '&tagging', 'GetBucketTagging'],
      ['PUT', '/', '&tagging', 'PutBucketTagging'],
      ['DELETE', '/', '&tagging', 'DeleteBucketTagging'],
      // Object-only subresources
      ['GET', '/object', '&retention', 'GetObjectRetention'],
      ['PUT', '/object', '&retention', 'PutObjectRetention'],
      ['GET', '/object', '&legal-hold', 'GetObjectLegalHold'],
      ['PUT', '/object', '&legal-hold', 'PutObjectLegalHold'],
      ['GET', '/object', '&torrent', 'GetObjectTorrent'],
    ];
    for (const [method, path, extraQuery, expectedOperation] of cases) {
      const attribution = attribute(
        presignedUrl(method, 'example-bucket.s3.us-west-2.amazonaws.com', path, extraQuery)
      );
      expect(attribution.remoteOperation).toEqual(expectedOperation);
    }
  });

  it('resolvesPathStyleOperation', () => {
    // method, path, extra query params, expected operation
    const cases: [string, string, string, string][] = [
      ['GET', '/example-bucket', '&list-type=2', 'ListObjectsV2'],
      // Trailing slash after the bucket is bucket-level, not an object key.
      ['GET', '/example-bucket/', '&list-type=2', 'ListObjectsV2'],
      ['GET', '/example-bucket/', '', 'UnknownRemoteOperation'],
      ['GET', '/example-bucket/object', '', 'GetObject'],
      ['DELETE', '/example-bucket/object', '', 'DeleteObject'],
      ['GET', '/example-bucket', '&acl', 'GetBucketAcl'],
      ['GET', '/example-bucket/', '&acl', 'GetBucketAcl'],
      ['GET', '/example-bucket/object', '&acl', 'GetObjectAcl'],
    ];
    for (const [method, path, extraQuery, expectedOperation] of cases) {
      const attribution = attribute(presignedUrl(method, 's3.us-west-2.amazonaws.com', path, extraQuery));
      expect(attribution.remoteOperation).toEqual(expectedOperation);
    }
  });

  it('failsClosedForUnrecognizedEndpoint', () => {
    const hosts: string[] = [
      // Access point host (bucket not identifiable from the endpoint form)
      'example-bucket.s3-accesspoint.us-west-2.amazonaws.com',
      // Custom CNAME
      's3.mycompany.com',
      // Non-S3 AWS service endpoint
      'sqs.us-west-2.amazonaws.com',
    ];
    for (const host of hosts) {
      const url = presignedUrl('GET', host, '/object');
      expect(url).not.toBeUndefined();
      expect(S3PresignedUrlAttributor.attribute(url!)).toBeUndefined();
    }
  });

  it('usesUnknownOperationForAmbiguousBucketOperation', () => {
    const attribution = attribute(presignedUrl('GET', 'example-bucket.s3.us-west-2.amazonaws.com', '/'));

    expect(attribution.remoteService).toEqual('AWS::S3');
    expect(attribution.remoteOperation).toEqual('UnknownRemoteOperation');
    expect(attribution.remoteResource).not.toBeUndefined();
  });

  it('missingHttpMethodUsesUnknownOperation', () => {
    const attribution = attribute(presignedUrl(undefined, 'example-bucket.s3.us-west-2.amazonaws.com', '/object'));

    expect(attribution.remoteService).toEqual('AWS::S3');
    expect(attribution.remoteOperation).toEqual('UnknownRemoteOperation');
  });

  it('pathStyleWithoutBucketAttributesS3WithoutResource', () => {
    const attribution = attribute(presignedUrl('GET', 's3.us-west-2.amazonaws.com', '/'));

    expect(attribution.remoteService).toEqual('AWS::S3');
    expect(attribution.remoteResource).toBeUndefined();
  });
});
