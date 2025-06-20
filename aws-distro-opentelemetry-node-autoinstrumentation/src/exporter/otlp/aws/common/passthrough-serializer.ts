// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ISerializer } from '@opentelemetry/otlp-transformer';

/**
 * A serializer that bypasses request serialization by returning pre-serialized data.
 * @template Response The type of the deserialized response
 */
export class PassthroughSerializer<Response> implements ISerializer<Uint8Array, Response> {
  private serializedData: Uint8Array = new Uint8Array();
  private deserializer: (data: Uint8Array) => Response;

  /**
   * Creates a new PassthroughSerializer instance.
   * @param deserializer Function to deserialize response data
   */
  constructor(deserializer: (data: Uint8Array) => Response) {
    this.deserializer = deserializer;
  }

  /**
   * Sets the pre-serialized data to be returned when serializeRequest is called.
   * @param data The serialized data to use
   */
  setSerializedData(data: Uint8Array): void {
    this.serializedData = data;
  }

  /**
   * Returns the pre-serialized data, ignoring the request parameter.
   * @param request Ignored parameter.
   * @returns The pre-serialized data
   */
  serializeRequest(request: Uint8Array): Uint8Array {
    return this.serializedData;
  }

  /**
   * Deserializes response data using the provided deserializer function.
   * @param data The response data to deserialize
   * @returns The deserialized response
   */
  deserializeResponse(data: Uint8Array): Response {
    return this.deserializer(data);
  }
}
