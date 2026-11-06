// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, INVALID_SPANID } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { IdGenerator } from '@opentelemetry/sdk-trace-base';
import { closeSync, openSync, readSync } from 'fs';

// AgentCore restores the state of both Math.random() and Node's OpenSSL random generator.
export class AgentCoreIdGenerator implements IdGenerator {
  generateTraceId(): string {
    const epoch = Math.floor(Date.now() / 1000)
      .toString(16)
      .padStart(8, '0');
    return epoch + this.generateRandomBytes(12);
  }

  generateSpanId(): string {
    const spanId = this.generateRandomBytes(8);
    return spanId === INVALID_SPANID ? '0000000000000001' : spanId;
  }

  private generateRandomBytes(length: number): string {
    return context.with(suppressTracing(context.active()), () => {
      const buffer = Buffer.allocUnsafe(length);
      const fd = openSync('/dev/urandom', 'r');
      try {
        let offset = 0;
        while (offset < length) {
          const bytesRead = readSync(fd, buffer, offset, length - offset, null);
          if (bytesRead === 0) {
            throw new Error('Unable to read random bytes from /dev/urandom');
          }
          offset += bytesRead;
        }
        return buffer.toString('hex');
      } finally {
        closeSync(fd);
      }
    });
  }
}
