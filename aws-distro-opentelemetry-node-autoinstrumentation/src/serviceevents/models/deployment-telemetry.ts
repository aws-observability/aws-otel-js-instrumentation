// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployment telemetry models.
 *
 * Hosts DeploymentContext (VCS + deployment env data shared by multiple signals)
 * and DeploymentEventTelemetry (the standalone aws.service_events.deployment_event signal).
 */

export interface DeploymentContextData {
  git_repo_url: string;
  git_commit_sha: string;
  deployment_url: string;
  deployment_timestamp: string;
  deployment_id: string;
}

export class DeploymentContext implements DeploymentContextData {
  git_repo_url: string;
  git_commit_sha: string;
  deployment_url: string;
  deployment_timestamp: string;
  deployment_id: string;

  constructor(params?: Partial<DeploymentContextData>) {
    this.git_repo_url = params?.git_repo_url ?? '';
    this.git_commit_sha = params?.git_commit_sha ?? '';
    this.deployment_url = params?.deployment_url ?? '';
    this.deployment_timestamp = params?.deployment_timestamp ?? '';
    this.deployment_id = params?.deployment_id ?? '';
  }

  static fromEnvironment(): DeploymentContext {
    return new DeploymentContext({
      git_repo_url: process.env.OTEL_AWS_SERVICE_EVENTS_GIT_REPO_URL ?? '',
      git_commit_sha: process.env.OTEL_AWS_SERVICE_EVENTS_GIT_COMMIT_SHA ?? '',
      deployment_url: process.env.OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_URL ?? '',
      deployment_timestamp: process.env.OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_TIMESTAMP ?? '',
      deployment_id: process.env.OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_ID ?? '',
    });
  }

  isEmpty(): boolean {
    return (
      !this.git_repo_url &&
      !this.git_commit_sha &&
      !this.deployment_url &&
      !this.deployment_timestamp &&
      !this.deployment_id
    );
  }

  toDict(): Record<string, string> {
    return {
      git_repo_url: this.git_repo_url,
      git_commit_sha: this.git_commit_sha,
      deployment_url: this.deployment_url,
      deployment_timestamp: this.deployment_timestamp,
      deployment_id: this.deployment_id,
    };
  }
}

/** DeploymentEvent LogRecord payload — spec §6. */
export class DeploymentEventTelemetry {
  deployment_context: DeploymentContext;

  constructor(deploymentContext?: DeploymentContext) {
    this.deployment_context = deploymentContext ?? DeploymentContext.fromEnvironment();
  }
}
