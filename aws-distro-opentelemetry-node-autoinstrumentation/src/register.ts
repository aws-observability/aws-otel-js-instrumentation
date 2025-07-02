// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

// Short-term workaround to avoid Upsteam OTel emitting logs such as:
// - `OTEL_TRACES_SAMPLER value "xray invalid, defaulting to always_on".`
// OTel dependencies will always load a default Sampler configuration. Although unused, that
// load process will read the `OTEL_TRACES_SAMPLER` value and may emit the above log, which is
// unwanted for `xray` value. Thus we temporarily remove this env var to avoid the unwanted log.
let useXraySampler = false;
if (process.env.OTEL_TRACES_SAMPLER === 'xray') {
  delete process.env.OTEL_TRACES_SAMPLER;
  useXraySampler = true;
}

import { diag, DiagConsoleLogger, trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations, InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node';
import { Instrumentation } from '@opentelemetry/instrumentation';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { AwsOpentelemetryConfigurator } from './aws-opentelemetry-configurator';
import { applyInstrumentationPatches, customExtractor } from './patches/instrumentation-patch';
import { getAwsRegionFromEnvironment, isAgentObservabilityEnabled } from './utils';

diag.setLogger(new DiagConsoleLogger(), opentelemetry.core.getEnv().OTEL_LOG_LEVEL);

/*
Sets up default environment variables and apply patches

Set default OTEL_EXPORTER_OTLP_PROTOCOL to be `http/protobuf` to remain consistent with other ADOT languages. This must be run before
`configurator.configure()`, which will use this value to create an OTel Metric Exporter that is used for the customized AWS Span Procesors.
The default value of OTEL_EXPORTER_OTLP_PROTOCOL should be `http/protobuf`:
https://github.com/open-telemetry/opentelemetry-js/blob/34003c9b7ef7e7e95e86986550d1c7fb6c1c56c6/packages/opentelemetry-core/src/utils/environment.ts#L233

Also sets default OTEL_PROPAGATORS to ensure good compatibility with X-Ray and Application Signals.

This file may also be used to apply patches to upstream instrumentation - usually these are stopgap measures until we can contribute
long-term changes to upstream.
*/

export function setAwsDefaultEnvironmentVariables() {
  if (!process.env.OTEL_EXPORTER_OTLP_PROTOCOL) {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
  }
  if (!process.env.OTEL_PROPAGATORS) {
    process.env.OTEL_PROPAGATORS = 'xray,tracecontext';
  }
  if (!process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS) {
    if (isAgentObservabilityEnabled()) {
      // Assume users only need instrumentations that are manually set-up outside of OpenTelemetry
      process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS =
        'amqplib,aws-lambda,aws-sdk,bunyan,cassandra-driver,connect,cucumber,dataloader,dns,express,fastify,fs,generic-pool,graphql,grpc,hapi,http,ioredis,kafkajs,knex,koa,lru-memoizer,memcached,mongodb,mongoose,mysql2,mysql,nestjs-core,net,pg,pino,redis,redis-4,restify,router,socket.io,tedious,undici,winston';
    } else {
      // Disable the following instrumentations by default
      // This auto-instrumentation for the `fs` module generates many low-value spans. `dns` is similar.
      // https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1344#issuecomment-1618993178
      process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'fs,dns';
    }
  }

  if (isAgentObservabilityEnabled()) {
    // Set exporter defaults
    if (!process.env.OTEL_TRACES_EXPORTER) {
      process.env.OTEL_TRACES_EXPORTER = 'otlp';
    }
    if (!process.env.OTEL_LOGS_EXPORTER) {
      process.env.OTEL_LOGS_EXPORTER = 'otlp';
    }
    if (!process.env.OTEL_METRICS_EXPORTER) {
      process.env.OTEL_METRICS_EXPORTER = 'awsemf';
    }

    // Set GenAI capture content default
    if (!process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT) {
      process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'true';
    }

    // Set sampler default
    if (!process.env.OTEL_TRACES_SAMPLER && !useXraySampler) {
      process.env.OTEL_TRACES_SAMPLER = 'parentbased_always_on';
    }

    // Disable AWS Application Signals by default
    if (!process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED) {
      process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED = 'false';
    }

    // Set OTLP endpoints with AWS region if not already set
    const region = getAwsRegionFromEnvironment();
    if (region) {
      if (!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `https://xray.${region}.amazonaws.com/v1/traces`;
      }

      if (!process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
        process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `https://logs.${region}.amazonaws.com/v1/logs`;
      }
    } else {
      diag.error(
        'AWS region could not be determined. OTLP endpoints will not be automatically configured. Please set AWS_REGION environment variable or configure OTLP endpoints manually.'
      );
    }
  }
}
setAwsDefaultEnvironmentVariables();

export const instrumentationConfigs: InstrumentationConfigMap = {
  '@opentelemetry/instrumentation-aws-lambda': {
    eventContextExtractor: customExtractor,
  },
  '@opentelemetry/instrumentation-aws-sdk': {
    suppressInternalInstrumentation: true,
  },
  '@opentelemetry/instrumentation-mongoose': {
    suppressInternalInstrumentation: true,
  },
};
const instrumentations: Instrumentation[] = getNodeAutoInstrumentations(instrumentationConfigs);

// Apply instrumentation patches
applyInstrumentationPatches(instrumentations);

const configurator: AwsOpentelemetryConfigurator = new AwsOpentelemetryConfigurator(instrumentations, useXraySampler);
const configuration: Partial<opentelemetry.NodeSDKConfiguration> = configurator.configure();

const sdk: opentelemetry.NodeSDK = new opentelemetry.NodeSDK(configuration);

// The OpenTelemetry Authors code
// We need to copy OpenTelemetry's register.ts file in order to provide the configuration
// created by AwsOpentelemetryConfigurator, which cannot be done by otherwise. In the long term,
// we wish to make contributions to upstream to improve customizability of the Node auto-instrumentation.
try {
  sdk.start();

  diag.info('Setting TraceProvider for instrumentations at the end of initialization');
  for (const instrumentation of instrumentations) {
    instrumentation.setTracerProvider(trace.getTracerProvider());
  }

  diag.debug(`Environment variable OTEL_PROPAGATORS is set to '${process.env.OTEL_PROPAGATORS}'`);
  diag.debug(`Environment variable OTEL_EXPORTER_OTLP_PROTOCOL is set to '${process.env.OTEL_EXPORTER_OTLP_PROTOCOL}'`);
  diag.info('AWS Distro of OpenTelemetry automatic instrumentation started successfully');
} catch (error) {
  diag.error(
    'Error initializing AWS Distro of OpenTelemetry SDK. Your application is not instrumented and will not produce telemetry',
    error
  );
}

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .then(() => diag.debug('AWS Distro of OpenTelemetry SDK terminated'))
    .catch(error => diag.error('Error terminating AWS Distro of OpenTelemetry SDK', error));
});

// END The OpenTelemetry Authors code

// Respect original `OTEL_TRACES_SAMPLER` as we previously deleted it temporarily for value `xray`
if (useXraySampler) {
  process.env.OTEL_TRACES_SAMPLER = 'xray';
}
