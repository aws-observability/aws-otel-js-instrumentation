// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Data model for OpenTelemetry resource attributes.
 *
 * Maps cloud/host/container/k8s attributes from OTel Resource objects
 * to a structured interface for inclusion in telemetry payloads.
 */

/**
 * Structured resource attributes from OpenTelemetry.
 */
export interface ResourceAttributesData {
  cloud_provider?: string;
  cloud_platform?: string;
  cloud_region?: string;
  cloud_account_id?: string;
  cloud_availability_zone?: string;
  host_id?: string;
  host_type?: string;
  container_id?: string;
  k8s_cluster_name?: string;
  k8s_pod_name?: string;
  k8s_namespace_name?: string;
}

/**
 * Mapping between ResourceAttributes field names and OTel dot-notation keys.
 */
export const OTEL_KEY_MAP: Record<string, string> = {
  cloud_provider: 'cloud.provider',
  cloud_platform: 'cloud.platform',
  cloud_region: 'cloud.region',
  cloud_account_id: 'cloud.account.id',
  cloud_availability_zone: 'cloud.availability_zone',
  host_id: 'host.id',
  host_type: 'host.type',
  container_id: 'container.id',
  k8s_cluster_name: 'k8s.cluster.name',
  k8s_pod_name: 'k8s.pod.name',
  k8s_namespace_name: 'k8s.namespace.name',
};

/** Reverse mapping: OTel key → field name. */
const REVERSE_KEY_MAP: Record<string, string> = {};
for (const [field, otelKey] of Object.entries(OTEL_KEY_MAP)) {
  REVERSE_KEY_MAP[otelKey] = field;
}

export class ResourceAttributes implements ResourceAttributesData {
  cloud_provider?: string;
  cloud_platform?: string;
  cloud_region?: string;
  cloud_account_id?: string;
  cloud_availability_zone?: string;
  host_id?: string;
  host_type?: string;
  container_id?: string;
  k8s_cluster_name?: string;
  k8s_pod_name?: string;
  k8s_namespace_name?: string;

  constructor(params?: Partial<ResourceAttributesData>) {
    if (params) {
      this.cloud_provider = params.cloud_provider;
      this.cloud_platform = params.cloud_platform;
      this.cloud_region = params.cloud_region;
      this.cloud_account_id = params.cloud_account_id;
      this.cloud_availability_zone = params.cloud_availability_zone;
      this.host_id = params.host_id;
      this.host_type = params.host_type;
      this.container_id = params.container_id;
      this.k8s_cluster_name = params.k8s_cluster_name;
      this.k8s_pod_name = params.k8s_pod_name;
      this.k8s_namespace_name = params.k8s_namespace_name;
    }
  }

  /**
   * Create ResourceAttributes from OTEL_RESOURCE_ATTRIBUTES environment variable.
   *
   * Parses the comma-separated key=value pairs looking for cloud/host/k8s attributes.
   */
  static fromEnvironment(): ResourceAttributes {
    const envResources = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
    if (!envResources) {
      return new ResourceAttributes();
    }

    const attrs: Record<string, string> = {};
    for (const pair of envResources.split(',')) {
      if (pair.includes('=')) {
        const [key, ...rest] = pair.split('=');
        attrs[key.trim()] = rest.join('=').trim();
      }
    }

    return ResourceAttributes.fromOtelResource({ attributes: attrs });
  }

  /**
   * Create ResourceAttributes from an OTel Resource object.
   *
   * Accepts any object with an `attributes` property (Record or Map-like).
   */
  static fromOtelResource(resource: { attributes: Record<string, unknown> } | null): ResourceAttributes {
    const ra = new ResourceAttributes();
    if (!resource || !resource.attributes) {
      return ra;
    }

    const attrs = resource.attributes;
    for (const [otelKey, fieldName] of Object.entries(REVERSE_KEY_MAP)) {
      const value = attrs[otelKey];
      if (value !== undefined && value !== null && value !== '') {
        (ra as any)[fieldName] = String(value);
      }
    }

    return ra;
  }

  /**
   * Convert to dictionary with OTel dot-notation keys.
   * Only includes fields that have values (sparse).
   */
  toDict(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [field, otelKey] of Object.entries(OTEL_KEY_MAP)) {
      const value = (this as any)[field];
      if (value !== undefined && value !== null && value !== '') {
        result[otelKey] = value;
      }
    }
    return result;
  }

  /**
   * Check if all fields are empty/undefined.
   */
  isEmpty(): boolean {
    for (const field of Object.keys(OTEL_KEY_MAP)) {
      const value = (this as any)[field];
      if (value !== undefined && value !== null && value !== '') {
        return false;
      }
    }
    return true;
  }
}
