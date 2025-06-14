// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
export const AWS_AUTH_PATH = '../../../../../src/exporter/otlp/aws/common/aws-authenticator';
export const AWS_SPAN_EXPORTER_PATH = '../../../../../src/exporter/otlp/aws/traces/otlp-aws-span-exporter';
export const AWS_LOG_EXPORTER_PATH = '../../../../../src/exporter/otlp/aws/logs/otlp-aws-log-exporter';

export const SIGNATURE_V4_MODULE = '@smithy/signature-v4';
export const CREDENTIAL_PROVIDER_MODULE = '@aws-sdk/credential-provider-node';
export const SHA_256_MODULE = '@aws-crypto/sha256-js';
export const AWS_HTTP_MODULE = '@smithy/protocol-http';

export const AWS_OTLP_TRACES_ENDPOINT = 'https://xray.us-east-1.amazonaws.com';
export const AWS_OTLP_TRACES_ENDPOINT_PATH = '/v1/traces';

export const AWS_OTLP_LOGS_ENDPOINT = 'https://logs.us-east-1.amazonaws.com';
export const AWS_OTLP_LOGS_ENDPOINT_PATH = '/v1/logs';

export const AUTHORIZATION_HEADER = 'authorization';
export const X_AMZ_DATE_HEADER = 'x-amz-date';
export const X_AMZ_SECURITY_TOKEN_HEADER = 'x-amz-security-token';
