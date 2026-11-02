// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import * as http from 'http';
import * as https from 'https';
import { ListConfigurationsRequest, ListConfigurationsResponse, ReportStatusRequest } from './model/api-response';
import { DI_USER_AGENT, DEFAULT_HTTP_TIMEOUT_MS, MAX_PAGES_PER_FETCH } from './model/types';

/**
 * HTTP client for DI control plane APIs.
 *
 * Communicates with the CloudWatch Agent proxy at the configured API URL.
 * Two endpoints:
 *   POST /list-instrumentation-configurations
 *   POST /report-instrumentation-configuration-status
 */
export class DynamicInstrumentationClient {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;

  constructor(apiUrl: string, timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS) {
    this.apiUrl = apiUrl.replace(/\/+$/, ''); // strip trailing slashes
    this.timeoutMs = timeoutMs;
  }

  /**
   * Fetch configurations for a given instrumentation type.
   * Handles pagination (up to MAX_PAGES_PER_FETCH pages).
   *
   * Returns the merged response with all configs from all pages,
   * using Changed/SyncedAt/SyncInterval from the first page.
   */
  async fetchConfigurations(
    service: string,
    environment: string,
    instrumentationType: string,
    lastSyncTime?: number
  ): Promise<ListConfigurationsResponse> {
    let allConfigs: Array<Record<string, unknown>> = [];
    let nextToken: string | undefined;
    let changed = true;
    let syncedAt: number | null = null;
    let syncInterval: number | null = null;

    for (let page = 0; page < MAX_PAGES_PER_FETCH; page++) {
      const request: ListConfigurationsRequest = {
        Service: service,
        Environment: environment,
        InstrumentationType: instrumentationType,
      };

      if (lastSyncTime !== undefined) {
        request.SyncedAt = lastSyncTime;
      }
      if (nextToken) {
        request.NextToken = nextToken;
      }

      const response = await this.post<ListConfigurationsResponse>('/list-instrumentation-configurations', request);

      // Store metadata from first page
      if (page === 0) {
        changed = response.Changed ?? true;
        syncedAt = response.SyncedAt ?? null;
        syncInterval = response.SyncInterval ?? null;
      }

      const configs = response.LatestConfigurations ?? [];
      allConfigs = allConfigs.concat(configs);

      nextToken = response.NextToken ?? undefined;
      if (!nextToken) break;
    }

    return {
      Changed: changed,
      SyncedAt: syncedAt,
      SyncInterval: syncInterval,
      LatestConfigurations: allConfigs,
      NextToken: null,
    };
  }

  /**
   * Report configuration status to the control plane.
   */
  async reportStatus(request: ReportStatusRequest): Promise<void> {
    await this.post('/report-instrumentation-configuration-status', request);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      context.with(suppressTracing(context.active()), () => {
        const url = new URL(path, this.apiUrl);
        const isHttps = url.protocol === 'https:';
        const transport = isHttps ? https : http;

        const data = JSON.stringify(body);
        const options: http.RequestOptions = {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          timeout: this.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'User-Agent': DI_USER_AGENT,
          },
        };

        const req = transport.request(options, res => {
          let responseBody = '';
          res.setEncoding('utf8');
          res.on('data', chunk => {
            responseBody += chunk;
          });
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0;

            if (statusCode === 404) {
              // No configurations found — not an error
              resolve({
                Changed: false,
                SyncedAt: null,
                SyncInterval: null,
                LatestConfigurations: [],
                NextToken: null,
              } as unknown as T);
              return;
            }

            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`HTTP ${statusCode}: ${responseBody.substring(0, 200)}`));
              return;
            }

            try {
              const parsed = JSON.parse(responseBody);
              resolve(parsed as T);
            } catch (parseError) {
              reject(new Error(`Failed to parse response: ${parseError}`));
            }
          });
        });

        req.on('error', error => {
          reject(error);
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Request timed out after ${this.timeoutMs}ms`));
        });

        req.write(data);
        req.end();
      });
    });
  }
}
