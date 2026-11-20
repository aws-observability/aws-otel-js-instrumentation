// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, INVALID_SPANID, INVALID_TRACEID } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { IdGenerator } from '@opentelemetry/sdk-trace-base';
import { randomFillSync } from 'crypto';
import { openSync, readSync } from 'fs';

const URANDOM_PATH = '/dev/urandom';

/**
 * Generates fully random trace IDs and span IDs, like the upstream `RandomIdGenerator`, from the operating
 * system's random source.
 *
 * The default ID generators use `Math.random()`, whose state lives in process memory. Platforms that start
 * processes by restoring a memory snapshot, such as Amazon Bedrock AgentCore Runtime, restore that state too,
 * so every restored process generates the same IDs. Node's `crypto` module doesn't avoid this either: it can
 * cache entropy in process, and a Node.js build that bundles its own OpenSSL restores the OpenSSL random state.
 * Reading `/dev/urandom` on every call keeps no random state in the process, so restored processes get
 * distinct IDs.
 */
export class SnapshotSafeIdGenerator implements IdGenerator {
  private fd: number | undefined;
  private urandomUnavailable: boolean = false;

  generateTraceId(): string {
    let traceId = this.generateRandomHex(16);
    while (traceId === INVALID_TRACEID) {
      traceId = this.generateRandomHex(16);
    }
    return traceId;
  }

  generateSpanId(): string {
    let spanId = this.generateRandomHex(8);
    while (spanId === INVALID_SPANID) {
      spanId = this.generateRandomHex(8);
    }
    return spanId;
  }

  private generateRandomHex(length: number): string {
    // Suppress tracing so that fs instrumentation does not create spans for these reads.
    return context.with(suppressTracing(context.active()), () => {
      const buffer = Buffer.allocUnsafe(length);
      if (!this.readUrandom(buffer)) {
        // Only on platforms without /dev/urandom, such as Windows.
        randomFillSync(buffer);
      }
      return buffer.toString('hex');
    });
  }

  private readUrandom(buffer: Buffer): boolean {
    if (this.urandomUnavailable) {
      return false;
    }
    try {
      // The file descriptor holds no random state, so it is safe to open it once and keep it across a snapshot.
      if (this.fd === undefined) {
        this.fd = openSync(URANDOM_PATH, 'r');
      }
      let offset = 0;
      while (offset < buffer.length) {
        const bytesRead = readSync(this.fd, buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) {
          throw new Error(`Unable to read random bytes from ${URANDOM_PATH}`);
        }
        offset += bytesRead;
      }
      return true;
    } catch {
      this.fd = undefined;
      this.urandomUnavailable = true;
      return false;
    }
  }
}
