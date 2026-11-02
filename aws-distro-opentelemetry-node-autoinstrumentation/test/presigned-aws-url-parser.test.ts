// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for PresignedAwsUrlParser.
//
// The parser detects presigned SigV4/SigV4a requests from non-sensitive signals only. It must work
// with the agent's default URL sanitization, which replaces the `X-Amz-Credential` and
// `X-Amz-Signature` values with `REDACTED`; therefore these tests use redacted values. The
// non-redacted presigned parameters (`X-Amz-Date`, `X-Amz-Expires`, `X-Amz-SignedHeaders`) are
// required, so valid URLs include them.

import { expect } from 'expect';
import { PresignedAwsUrlParser } from '../src/presigned-aws-url-parser';

const OBJECT_URL: string = 'https://example-bucket.s3.us-west-2.amazonaws.com/object';
const CREDENTIAL_AND_SIGNATURE: string = '&X-Amz-Credential=REDACTED&X-Amz-Signature=REDACTED';
const PRESIGN_PARAMS: string = '&X-Amz-Date=20260710T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host';

function presignedUrl(host: string, path: string, algorithm: string = 'AWS4-HMAC-SHA256'): string {
  return 'https://' + host + path + '?X-Amz-Algorithm=' + algorithm + CREDENTIAL_AND_SIGNATURE + PRESIGN_PARAMS;
}

describe('PresignedAwsUrlParserTest', () => {
  it('detectsSigV4PresignedRequest', () => {
    const parsed = PresignedAwsUrlParser.parse(
      presignedUrl('example-bucket.s3.us-west-2.amazonaws.com', '/photos/seed.jpg'),
      'GET'
    );

    expect(parsed).not.toBeUndefined();
    expect(parsed!.getHttpMethod()).toEqual('GET');
    expect(parsed!.getHost()).toEqual('example-bucket.s3.us-west-2.amazonaws.com');
    expect(parsed!.getPath()).toEqual('/photos/seed.jpg');
  });

  it('detectsSigV4aPresignedRequest', () => {
    const parsed = PresignedAwsUrlParser.parse(
      presignedUrl('example-bucket.s3.amazonaws.com', '/object', 'AWS4-ECDSA-P256-SHA256'),
      'GET'
    );
    expect(parsed).not.toBeUndefined();
  });

  it('detectsRequestWithNonRedactedCredentialAndSignature', () => {
    // Detection must also work before sanitization (e.g. when redaction is disabled), where the
    // credential and signature carry real values.
    const parsed = PresignedAwsUrlParser.parse(
      'https://example-bucket.s3.us-west-2.amazonaws.com/object' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAEXAMPLE%2F20260710%2Fus-west-2%2Fs3%2Faws4_request' +
        '&X-Amz-Signature=1234567890abcdef' +
        PRESIGN_PARAMS,
      'GET'
    );
    expect(parsed).not.toBeUndefined();
  });

  it('parsesUrlWithValuelessQueryParameterAndEmptyPath', () => {
    const parsed = PresignedAwsUrlParser.parse(
      'https://example-bucket.s3.amazonaws.com' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        CREDENTIAL_AND_SIGNATURE +
        PRESIGN_PARAMS +
        '&x-id',
      'GET'
    );

    expect(parsed).not.toBeUndefined();
    expect(parsed!.getPath()).toEqual('/');
  });

  it('rejectsMalformedOrNonPresignedUrls', () => {
    const cases: { [description: string]: string | undefined } = {
      'undefined url': undefined,
      'empty url': '',
      'plain url without SigV4 parameters': 'https://example.com/object',
      'cloudfront signed url':
        'https://d111111abcdef8.cloudfront.net/image.jpg?Policy=policy&Signature=sig&Key-Pair-Id=key',
      'missing algorithm': OBJECT_URL + '?' + CREDENTIAL_AND_SIGNATURE.substring(1) + PRESIGN_PARAMS,
      'unsupported algorithm': OBJECT_URL + '?X-Amz-Algorithm=AWS5-FAKE' + CREDENTIAL_AND_SIGNATURE + PRESIGN_PARAMS,
      'missing credential': OBJECT_URL + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=REDACTED' + PRESIGN_PARAMS,
      'missing signature': OBJECT_URL + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=REDACTED' + PRESIGN_PARAMS,
      'empty credential':
        OBJECT_URL + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=&X-Amz-Signature=REDACTED' + PRESIGN_PARAMS,
      'empty signature':
        OBJECT_URL + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=REDACTED&X-Amz-Signature=' + PRESIGN_PARAMS,
      'missing date':
        OBJECT_URL +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        CREDENTIAL_AND_SIGNATURE +
        '&X-Amz-Expires=3600&X-Amz-SignedHeaders=host',
      'missing expires':
        OBJECT_URL +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        CREDENTIAL_AND_SIGNATURE +
        '&X-Amz-Date=20260710T120000Z&X-Amz-SignedHeaders=host',
      'missing signed headers':
        OBJECT_URL +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        CREDENTIAL_AND_SIGNATURE +
        '&X-Amz-Date=20260710T120000Z&X-Amz-Expires=3600',
      'empty presigned parameter value':
        OBJECT_URL +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        CREDENTIAL_AND_SIGNATURE +
        '&X-Amz-Date=&X-Amz-Expires=3600&X-Amz-SignedHeaders=host',
    };

    for (const description of Object.keys(cases)) {
      expect(PresignedAwsUrlParser.parse(cases[description], 'GET')).toBeUndefined();
    }
  });
});
