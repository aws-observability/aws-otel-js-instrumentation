// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context, diag, INVALID_SPANID, INVALID_TRACEID } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { IdGenerator } from '@opentelemetry/sdk-trace-base';
import { randomFillSync } from 'crypto';
import { closeSync, existsSync, openSync, readSync } from 'fs';

const URANDOM_PATH = '/dev/urandom';
// Attempts per ID: the first read, then one retry with a freshly opened descriptor.
const URANDOM_ATTEMPTS = 2;

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
  // Platforms without /dev/urandom, such as Windows, always use crypto. This is decided once and is separate
  // from read errors on platforms that have /dev/urandom.
  private readonly urandomSupported: boolean = withTracingSuppressed(() => existsSync(URANDOM_PATH));
  private fd: number | undefined;
  private fallbackWarned: boolean = false;

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
    return withTracingSuppressed(() => {
      const buffer = Buffer.allocUnsafe(length);
      if (!this.urandomSupported || !this.readUrandom(buffer)) {
        randomFillSync(buffer);
      }
      return buffer.toString('hex');
    });
  }

  // Reads from /dev/urandom, reopening it after an error such as EMFILE. Returns false only when every attempt
  // for this ID failed; the next ID tries /dev/urandom again.
  private readUrandom(buffer: Buffer): boolean {
    for (let attempt = 0; attempt < URANDOM_ATTEMPTS; attempt++) {
      try {
        // The file descriptor holds no random state, so it is safe to keep it open across a snapshot.
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
      } catch (error) {
        this.closeFd();
        if (attempt === URANDOM_ATTEMPTS - 1 && !this.fallbackWarned) {
          this.fallbackWarned = true;
          diag.warn(`SnapshotSafeIdGenerator: failed to read ${URANDOM_PATH}, using crypto for this ID`, error);
        }
      }
    }
    return false;
  }

  private closeFd(): void {
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // The descriptor is already unusable; nothing else to clean up.
      }
      this.fd = undefined;
    }
  }
}

function withTracingSuppressed<T>(fn: () => T): T {
  return context.with(suppressTracing(context.active()), fn);
}
