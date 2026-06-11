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

import { diag, DiagConsoleLogger, metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { getNodeAutoInstrumentations, InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node';
import { getStringFromEnv, diagLogLevelFromString } from '@opentelemetry/core';
import { Instrumentation } from '@opentelemetry/instrumentation';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { AwsOpentelemetryConfigurator } from './aws-opentelemetry-configurator';
import {
  LangChainInstrumentation,
  INSTRUMENTATION_SHORT_NAME as LANGCHAIN_SHORT_NAME,
} from './instrumentation/instrumentation-langchain/instrumentation';
import {
  OpenAIAgentsInstrumentation,
  INSTRUMENTATION_SHORT_NAME as OPENAI_AGENTS_SHORT_NAME,
} from './instrumentation/instrumentation-openai-agents/instrumentation';
import {
  VercelAIInstrumentation,
  INSTRUMENTATION_SHORT_NAME as VERCEL_AI_SHORT_NAME,
} from './instrumentation/instrumentation-vercel-ai/instrumentation';
import { applyInstrumentationPatches, customExtractor } from './patches/instrumentation-patch';
import { getAwsRegionFromEnvironment, isAgentObservabilityEnabled } from './utils';

const logLevelEnv = getStringFromEnv('OTEL_LOG_LEVEL');
const logLevel = logLevelEnv ? diagLogLevelFromString(logLevelEnv) : undefined;
diag.setLogger(new DiagConsoleLogger(), logLevel);

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

export type ServiceEventsBootstrapDecision =
  | { action: 'skip'; reason: 'lambda' | 'bundledOff' | 'explicitOff' }
  | { action: 'skipForceEnabledWithoutEndpoints' }
  | { action: 'init' };

/**
 * Decide whether `register.ts` should initialize ServiceEvents for the given env snapshot.
 *
 * Rules:
 * - Lambda (`AWS_LAMBDA_FUNCTION_NAME` present) always disables ServiceEvents.
 * - Explicit `OTEL_AWS_SERVICE_EVENTS_ENABLED` overrides; unset follows `OTEL_AWS_APPLICATION_SIGNALS_ENABLED`.
 * - When force-enabled (explicit true + App Signals off), both
 *   `OTEL_AWS_OTLP_LOGS_ENDPOINT` and `OTEL_AWS_OTLP_METRICS_ENDPOINT`
 *   must be set; otherwise skip with an error.
 *
 * Exported for unit testing.
 */
export function resolveServiceEventsBootstrap(env: NodeJS.ProcessEnv): ServiceEventsBootstrapDecision {
  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    return { action: 'skip', reason: 'lambda' };
  }
  const raw = env.OTEL_AWS_SERVICE_EVENTS_ENABLED?.trim().toLowerCase();
  const appSignalsEnabled = env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED?.trim().toLowerCase() === 'true';
  if (raw === 'false') {
    return { action: 'skip', reason: 'explicitOff' };
  }
  const explicitOn = raw === 'true';
  if (!explicitOn && !appSignalsEnabled) {
    return { action: 'skip', reason: 'bundledOff' };
  }
  if (explicitOn && !appSignalsEnabled) {
    const logsSet = !!env.OTEL_AWS_OTLP_LOGS_ENDPOINT?.trim();
    const metricsSet = !!env.OTEL_AWS_OTLP_METRICS_ENDPOINT?.trim();
    if (!(logsSet && metricsSet)) {
      return { action: 'skipForceEnabledWithoutEndpoints' };
    }
  }
  return { action: 'init' };
}

export function setAwsDefaultEnvironmentVariables() {
  if (!process.env.OTEL_EXPORTER_OTLP_PROTOCOL) {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
  }
  if (!process.env.OTEL_PROPAGATORS) {
    // Propagators are run in the order they are configured.
    // xray is set after baggage in case xray propagator depends on the result of the baggage header extraction.
    process.env.OTEL_PROPAGATORS = 'baggage,xray,tracecontext';
  }
  if (!process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS) {
    // Disable the following instrumentations by default
    // This auto-instrumentation for the `fs` module generates many low-value spans. `dns` is similar.
    // https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1344#issuecomment-1618993178
    process.env.OTEL_NODE_DISABLED_INSTRUMENTATIONS = 'fs,dns';
  }

  if (isAgentObservabilityEnabled()) {
    if (!process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS) {
      // Assume users only need aws-sdk, aws-lambda, and our custom GenAI instrumentations,
      // as well as instrumentations that are manually set-up outside of OpenTelemetry.
      process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = `aws-lambda,aws-sdk,http,undici,${LANGCHAIN_SHORT_NAME},${OPENAI_AGENTS_SHORT_NAME},${VERCEL_AI_SHORT_NAME}`;
    }

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

    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
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
}
setAwsDefaultEnvironmentVariables();

export const isHttpPingRequest = (request: { url?: string }) => request.url === '/ping';
export const isUndiciPingRequest = (request: { path: string }) => request.path === '/ping';

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
  ...(isAgentObservabilityEnabled() && {
    '@opentelemetry/instrumentation-http': {
      ignoreIncomingRequestHook: isHttpPingRequest,
    },
    '@opentelemetry/instrumentation-undici': {
      ignoreRequestHook: isUndiciPingRequest,
    },
  }),
};
export const instrumentations: Instrumentation[] = getNodeAutoInstrumentations(instrumentationConfigs);

const captureMessageContent = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT !== 'false';
instrumentations.push(new LangChainInstrumentation({ captureMessageContent }));
instrumentations.push(new OpenAIAgentsInstrumentation({ captureMessageContent }));
instrumentations.push(new VercelAIInstrumentation({ captureMessageContent }));

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
    instrumentation.setMeterProvider(metrics.getMeterProvider());
    if (instrumentation.setLoggerProvider) {
      instrumentation.setLoggerProvider(logs.getLoggerProvider());
    }
  }

  diag.debug(`Environment variable OTEL_PROPAGATORS is set to '${process.env.OTEL_PROPAGATORS}'`);
  diag.debug(`Environment variable OTEL_EXPORTER_OTLP_PROTOCOL is set to '${process.env.OTEL_EXPORTER_OTLP_PROTOCOL}'`);
  diag.info('AWS Distro of OpenTelemetry automatic instrumentation started successfully');

  // Initialize ServiceEvents deep observability instrumentation (main thread only).
  // When the DI manager spawns a Worker, Node re-runs `--require register` inside
  // the worker's isolated V8 context, which would otherwise create a second
  // ServiceEventsInstrumentation + emitter. Python uses threading.Thread (shared
  // module namespace) so this isn't needed there. Keep behaviour aligned.
  try {
    const { isMainThread: serviceeventsIsMainThread } = require('worker_threads');
    const decision = resolveServiceEventsBootstrap(process.env);
    if (serviceeventsIsMainThread && decision.action === 'skipForceEnabledWithoutEndpoints') {
      diag.error(
        'ServiceEvents force-enabled (OTEL_AWS_SERVICE_EVENTS_ENABLED=true) without Application Signals, ' +
          'but OTEL_AWS_OTLP_LOGS_ENDPOINT / OTEL_AWS_OTLP_METRICS_ENDPOINT are unset ' +
          'or empty. Both are required in this mode. Skipping ServiceEvents initialization.'
      );
    } else if (serviceeventsIsMainThread && decision.action === 'init') {
      const { createServiceEventsConfigFromEnv, getServiceEventsInstrumentation } = require('./serviceevents');
      // config.enabled mirrors OTEL_AWS_SERVICE_EVENTS_ENABLED directly; the outer
      // bundling gate above has already decided ServiceEvents should run, so flip
      // the inner flag on regardless of whether the env var was set.
      const serviceeventsConfig = { ...createServiceEventsConfigFromEnv(), enabled: true };
      const serviceevents = getServiceEventsInstrumentation(serviceeventsConfig);
      if (serviceevents) {
        serviceevents.initialize();
      }
    }
  } catch (serviceeventsError) {
    diag.error('Failed to initialize ServiceEvents instrumentation', serviceeventsError);
  }
} catch (error) {
  diag.error(
    'Error initializing AWS Distro of OpenTelemetry SDK. Your application is not instrumented and will not produce telemetry',
    error
  );
}

process.on('SIGTERM', () => {
  // Shutdown ServiceEvents (main thread only — matches init-side guard).
  // shutdown() is async (it force-flushes buffered telemetry); await it before
  // tearing down the core SDK so the final window of ServiceEvents data is not
  // dropped on container stop. Failures are swallowed inside shutdown().
  let serviceeventsShutdown: Promise<void> = Promise.resolve();
  try {
    const { isMainThread: isMainServiceEvents } = require('worker_threads');
    if (isMainServiceEvents) {
      const { getServiceEventsInstrumentation } = require('./serviceevents');
      const serviceevents = getServiceEventsInstrumentation();
      if (serviceevents) {
        serviceeventsShutdown = serviceevents.shutdown();
      }
    }
  } catch {
    // Ignore - ServiceEvents may not have been initialized
  }

  void serviceeventsShutdown
    .catch(() => {
      // shutdown() already swallows errors; this is defensive only.
    })
    .then(() =>
      sdk
        .shutdown()
        .then(() => diag.debug('AWS Distro of OpenTelemetry SDK terminated'))
        .catch(error => diag.error('Error terminating AWS Distro of OpenTelemetry SDK', error))
    );
});

// END The OpenTelemetry Authors code

// Respect original `OTEL_TRACES_SAMPLER` as we previously deleted it temporarily for value `xray`
if (useXraySampler) {
  process.env.OTEL_TRACES_SAMPLER = 'xray';
}
