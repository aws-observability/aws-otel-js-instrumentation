// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resource detector that fetches the EC2 Auto Scaling group name from IMDS instance
 * tags and exposes it as `ec2.tag.aws:autoscaling:groupName`.
 *
 * The stock `@opentelemetry/resource-detector-aws` EC2 detector only reads the
 * instance-identity document — it does NOT fetch instance tags, so the ASG is absent
 * from the SDK Resource. The CloudWatch agent, by contrast, reads the ASG from IMDS
 * instance tags (`/latest/meta-data/tags/instance/aws:autoscaling:groupName`) and uses
 * it to resolve `ec2:<asg>`. This detector closes that gap so the SDK can compute the
 * same `aws.local.environment` the agent would on EC2 — without depending on the agent.
 *
 * Mirrors the agent's mechanism (amazon-cloudwatch-agent serviceprovider
 * `scrapeImdsServiceNameAndASG` + ec2tagger `Ec2InstanceTagKeyASG`): IMDSv2 token,
 * then read the instance tag. Instance metadata tags must be enabled on the instance
 * (`InstanceMetadataTags=enabled`); when they aren't, the detector returns nothing and
 * the resolver falls back to `ec2:default` — matching the agent's behavior.
 */

import { diag } from '@opentelemetry/api';
import { DetectedResource, ResourceDetector } from '@opentelemetry/resources';
import * as http from 'http';

const IMDS_HOST = '169.254.169.254';
const TOKEN_PATH = '/latest/api/token';
const ASG_TAG_PATH = '/latest/meta-data/tags/instance/aws:autoscaling:groupName';
const TOKEN_TTL_HEADER = 'X-aws-ec2-metadata-token-ttl-seconds';
const TOKEN_HEADER = 'X-aws-ec2-metadata-token';
const TIMEOUT_MS = 1000;

/** The resource attribute key the environment resolver reads — matches the agent's. */
export const EC2_ASG_ATTRIBUTE = 'ec2.tag.aws:autoscaling:groupName';

/**
 * Detects the EC2 Auto Scaling group via IMDS instance tags. Resolves to an empty
 * Resource (no error) when not on EC2 or when instance tags are unavailable.
 */
export class Ec2AutoScalingGroupDetector implements ResourceDetector {
  // IMDS host:port. Overridable for tests; defaults to the EC2 link-local address.
  private readonly imdsHost: string;

  constructor(imdsHost: string = IMDS_HOST) {
    this.imdsHost = imdsHost;
  }

  detect(): DetectedResource {
    // Attribute values may be Promises in resources 2.x; the SDK awaits them when the
    // Resource is materialized. Returning undefined (on non-EC2 / no tags) omits the key.
    return {
      attributes: {
        [EC2_ASG_ATTRIBUTE]: this._fetchAsg(),
      },
    };
  }

  private async _fetchAsg(): Promise<string | undefined> {
    try {
      const token = await this._fetchToken();
      const asg = await this._fetchString({
        ...this._hostPort(),
        path: ASG_TAG_PATH,
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: { [TOKEN_HEADER]: token },
      });
      const trimmed = asg.trim();
      return trimmed || undefined;
    } catch (e) {
      // Not on EC2, IMDS unreachable, or instance tags not enabled — all expected,
      // non-fatal. The resolver falls back to ec2:default, matching the agent.
      diag.debug('Ec2AutoScalingGroupDetector: ASG not available via IMDS instance tags', e);
      return undefined;
    }
  }

  private async _fetchToken(): Promise<string> {
    return this._fetchString({
      ...this._hostPort(),
      path: TOKEN_PATH,
      method: 'PUT',
      timeout: TIMEOUT_MS,
      headers: { [TOKEN_TTL_HEADER]: '60' },
    });
  }

  /** Split the configured IMDS host into { host, port } for http.request. */
  private _hostPort(): { host: string; port?: number } {
    const idx = this.imdsHost.lastIndexOf(':');
    if (idx > 0) {
      return { host: this.imdsHost.slice(0, idx), port: Number(this.imdsHost.slice(idx + 1)) };
    }
    return { host: this.imdsHost };
  }

  private _fetchString(options: http.RequestOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        req.abort();
        reject(new Error('IMDS request timed out'));
      }, TIMEOUT_MS);
      const req = http.request(options, res => {
        clearTimeout(timeoutId);
        const statusCode = res.statusCode ?? 0;
        res.setEncoding('utf8');
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          if (statusCode >= 200 && statusCode < 300) {
            resolve(raw);
          } else {
            reject(new Error(`IMDS request failed with status ${statusCode}`));
          }
        });
      });
      req.on('error', err => {
        clearTimeout(timeoutId);
        reject(err);
      });
      req.end();
    });
  }
}
