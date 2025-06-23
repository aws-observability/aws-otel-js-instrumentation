// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'mocha';
import expect from 'expect';
import { PassthroughSerializer } from '../../../../../src/exporter/otlp/aws/common/passthrough-serializer';

describe('PassthroughSerializer', () => {
  it('should set and return serialized data', () => {
    const mockDeserializeResponse = (data: Uint8Array) => ({ success: true });
    const serializer = new PassthroughSerializer(mockDeserializeResponse);

    const testData = new Uint8Array([1, 2, 3]);
    serializer.setSerializedData(testData);

    const result = serializer.serializeRequest(new Uint8Array());
    expect(result).toBe(testData);
  });

  it('should call deserializeResponse with provided function', () => {
    const mockResponse = { success: true };
    const mockDeserializeResponse = (data: Uint8Array) => mockResponse;
    const serializer = new PassthroughSerializer(mockDeserializeResponse);

    const testData = new Uint8Array([1, 2, 3]);
    const result = serializer.deserializeResponse(testData);

    expect(result).toBe(mockResponse);
  });
});
