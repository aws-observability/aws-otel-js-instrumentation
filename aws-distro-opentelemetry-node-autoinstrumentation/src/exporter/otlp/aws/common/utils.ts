// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base';

export function changeUrlConfig(endpoint: string, config?: OTLPExporterNodeConfigBase): OTLPExporterNodeConfigBase {
  if (config) {
    return {
      ...config,
      url: endpoint,
    };
  }

  return { url: endpoint };
}
