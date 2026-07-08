// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resource detector that fetches the ECS cluster ARN from the ECS task metadata endpoint
 * and exposes it as `aws.ecs.cluster.arn` (+ `cloud.platform=aws_ecs`).
 *
 * Why this exists: the stock `@opentelemetry/resource-detector-aws` AwsEcsDetector
 * (2.19.0) returns its result as `{ attributes: Promise<{...}> }` — i.e. `attributes` is a
 * single Promise of the whole object. The `@opentelemetry/resources` (2.x) DetectedResource
 * contract instead expects `attributes` to be an OBJECT whose VALUES may be promises
 * (per-key). `ResourceImpl` does `Object.entries(attributes)`, and `Object.entries(promise)`
 * is `[]` — so the ECS detector's attributes silently never enter the SDK Resource, and
 * `aws.ecs.cluster.arn` is absent. ServiceEvents then resolves `ec2:default` on ECS instead
 * of `ecs:<cluster>`. (EC2/EKS detectors use the correct per-key shape and are unaffected.)
 *
 * This detector reads the SAME source the agent + AwsEcsDetector use
 * (`$ECS_CONTAINER_METADATA_URI_V4/task` → `Cluster`) but returns per-key promises, so the
 * cluster ARN actually lands on the Resource and the environment resolver can compute
 * `ecs:<cluster>` matching the CloudWatch agent.
 */

import { diag } from '@opentelemetry/api';
import { DetectedResource, ResourceDetector } from '@opentelemetry/resources';
import * as http from 'http';

const TIMEOUT_MS = 1000;
const AWS_ECS_CLUSTER_ARN = 'aws.ecs.cluster.arn';
const CLOUD_PLATFORM = 'cloud.platform';

/**
 * Detects the ECS cluster ARN from the task metadata v4 endpoint. Resolves to an empty
 * Resource (no error) when not on ECS or when the endpoint is unavailable.
 */
export class EcsClusterDetector implements ResourceDetector {
  // Overridable for tests; defaults to the ECS task metadata v4 endpoint from the
  // ECS_CONTAINER_METADATA_URI_V4 env var the ECS agent injects into every container.
  private readonly metadataUriV4?: string;

  constructor(metadataUriV4: string | undefined = process.env.ECS_CONTAINER_METADATA_URI_V4) {
    this.metadataUriV4 = metadataUriV4;
  }

  detect(): DetectedResource {
    // Not on ECS (no metadata endpoint) → contribute nothing.
    if (!this.metadataUriV4) {
      return { attributes: {} };
    }
    // Per-key promises (the correct DetectedResource shape). The SDK awaits these when the
    // Resource is materialized (and our SE emitter awaits waitForAsyncAttributes()).
    const clusterArn = this._fetchClusterArn();
    return {
      attributes: {
        [AWS_ECS_CLUSTER_ARN]: clusterArn,
        // Only claim the ECS platform once we've confirmed the cluster ARN resolved, so we
        // don't mislabel a non-ECS host. undefined omits the key.
        [CLOUD_PLATFORM]: clusterArn.then(arn => (arn ? 'aws_ecs' : undefined)),
      },
    };
  }

  private async _fetchClusterArn(): Promise<string | undefined> {
    try {
      const body = await this._fetchString(`${this.metadataUriV4}/task`);
      const task = JSON.parse(body) as { Cluster?: string; TaskARN?: string };
      const cluster = (task.Cluster ?? '').trim();
      if (!cluster) {
        return undefined;
      }
      // `Cluster` may be a bare name or a full ARN. When it's a bare name, derive the ARN
      // from the task ARN (same as AwsEcsDetector), so the value matches the agent's.
      if (cluster.startsWith('arn:')) {
        return cluster;
      }
      const taskArn = task.TaskARN ?? '';
      const baseArn = taskArn.slice(0, taskArn.lastIndexOf(':'));
      return baseArn ? `${baseArn}:cluster/${cluster}` : cluster;
    } catch (e) {
      // Not on ECS, endpoint unreachable, or malformed body — all expected, non-fatal.
      diag.debug('EcsClusterDetector: ECS cluster ARN not available from task metadata', e);
      return undefined;
    }
  }

  private _fetchString(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        req.abort();
        reject(new Error('ECS metadata request timed out'));
      }, TIMEOUT_MS);
      const req = http.get(url, { timeout: TIMEOUT_MS }, res => {
        clearTimeout(timeoutId);
        const statusCode = res.statusCode ?? 0;
        res.setEncoding('utf8');
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          if (statusCode >= 200 && statusCode < 300) {
            resolve(raw);
          } else {
            reject(new Error(`ECS metadata request failed with status ${statusCode}`));
          }
        });
      });
      req.on('error', err => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }
}
