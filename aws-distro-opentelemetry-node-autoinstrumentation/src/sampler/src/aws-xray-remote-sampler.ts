// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, Context, DiagLogger, Link, SpanKind, diag } from '@opentelemetry/api';
import { ParentBasedSampler, Sampler, SamplingResult } from '@opentelemetry/sdk-trace-base';
import { AwsXraySamplingClient } from './aws-xray-sampling-client';
import { FallbackSampler } from './fallback-sampler';
import {
  AwsXRayRemoteSamplerConfig,
  GetSamplingRulesResponse,
  GetSamplingTargetsBody,
  GetSamplingTargetsResponse,
  SamplingRuleRecord,
  SamplingTargetDocument,
} from './remote-sampler.types';
import { DEFAULT_TARGET_POLLING_INTERVAL_SECONDS, RuleCache, TargetMap } from './rule-cache';
import { SamplingRuleApplier } from './sampling-rule-applier';

// 5 minute default sampling rules polling interval
const DEFAULT_RULES_POLLING_INTERVAL_SECONDS: number = 5 * 60;
// Default endpoint for awsproxy : https://aws-otel.github.io/docs/getting-started/remote-sampling#enable-awsproxy-extension
const DEFAULT_AWS_PROXY_ENDPOINT: string = 'http://localhost:2000';

export class AwsXRayRemoteSampler implements Sampler {
  private rulePollingIntervalMillis: number;
  private targetPollingInterval: number;
  private awsProxyEndpoint: string;
  private ruleCache: RuleCache;
  private fallbackSampler: ParentBasedSampler;
  private samplerDiag: DiagLogger;
  private rulePoller: NodeJS.Timer | undefined;
  private targetPoller: NodeJS.Timer | undefined;
  private clientId: string;
  private rulePollingJitterMillis: number;
  private targetPollingJitterMillis: number;
  private samplingClient: AwsXraySamplingClient;

  constructor(samplerConfig: AwsXRayRemoteSamplerConfig) {
    this.samplerDiag = diag.createComponentLogger({
      namespace: '@aws-observability/aws-xray-remote-sampler',
    });

    if (samplerConfig.pollingInterval == null || samplerConfig.pollingInterval < 10) {
      this.samplerDiag.warn(
        `'pollingInterval' is undefined or too small. Defaulting to ${DEFAULT_RULES_POLLING_INTERVAL_SECONDS}`
      );
      this.rulePollingIntervalMillis = DEFAULT_RULES_POLLING_INTERVAL_SECONDS * 1000;
    } else {
      this.rulePollingIntervalMillis = samplerConfig.pollingInterval * 1000;
    }

    this.rulePollingJitterMillis = Math.random() * 5 * 1000;
    this.targetPollingInterval = DEFAULT_TARGET_POLLING_INTERVAL_SECONDS;
    this.targetPollingJitterMillis = (Math.random() / 10) * 1000;

    this.awsProxyEndpoint = samplerConfig.endpoint ? samplerConfig.endpoint : DEFAULT_AWS_PROXY_ENDPOINT;
    this.fallbackSampler = new ParentBasedSampler({ root: new FallbackSampler() });
    this.clientId = this.generateClientId();
    this.ruleCache = new RuleCache(samplerConfig.resource);

    this.samplingClient = new AwsXraySamplingClient(this.awsProxyEndpoint, this.samplerDiag);

    // Start the Sampling Rules poller
    this.startSamplingRulesPoller();

    // execute first Sampling Targets update and then start the Sampling Targets poller
    this.getAndUpdateSamplingTargets();
    this.startSamplingTargetsPoller();
  }

  public shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    if (this.ruleCache.isExpired()) {
      return this.fallbackSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
    }

    const matchedRule: SamplingRuleApplier | undefined = this.ruleCache.getMatchedRule(attributes);
    if (matchedRule) {
      return matchedRule.shouldSample(context, traceId, spanName, spanKind, attributes, links);
    }

    this.samplerDiag.debug(
      'Using fallback sampler as no rule match was found. This is likely due to a bug, since default rule should always match'
    );
    return this.fallbackSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  public toString(): string {
    return 'AwsXRayRemoteSampler{remote sampling with AWS X-Ray}';
  }

  private startSamplingRulesPoller(): void {
    // Execute first update
    this.getAndUpdateSamplingRules();
    // Update sampling rules every 5 minutes (or user-defined polling interval)
    this.rulePoller = setInterval(
      () => this.getAndUpdateSamplingRules(),
      this.rulePollingIntervalMillis + this.rulePollingJitterMillis
    );
    this.rulePoller.unref();
  }

  private startSamplingTargetsPoller(): void {
    // Update sampling targets every targetPollingInterval (usually 10 seconds)
    this.targetPoller = setInterval(
      () => this.getAndUpdateSamplingTargets(),
      this.targetPollingInterval * 1000 + this.targetPollingJitterMillis
    );
    this.targetPoller.unref();
  }

  private getAndUpdateSamplingTargets(): void {
    const requestBody: GetSamplingTargetsBody = {
      SamplingStatisticsDocuments: this.ruleCache.createSamplingStatisticsDocuments(this.clientId),
    };

    this.samplingClient.fetchSamplingTargets(requestBody, this.updateSamplingTargets.bind(this));
  }

  private getAndUpdateSamplingRules(): void {
    this.samplingClient.fetchSamplingRules(this.updateSamplingRules.bind(this));
  }

  private updateSamplingRules(responseObject: GetSamplingRulesResponse): void {
    let samplingRules: SamplingRuleApplier[] = [];

    samplingRules = [];
    if (responseObject.SamplingRuleRecords) {
      responseObject.SamplingRuleRecords.forEach((record: SamplingRuleRecord) => {
        if (record.SamplingRule) {
          samplingRules.push(new SamplingRuleApplier(record.SamplingRule, undefined));
        }
      });
      this.ruleCache.updateRules(samplingRules);
    } else {
      this.samplerDiag.error('SamplingRuleRecords from GetSamplingRules request is not defined');
    }
  }

  private updateSamplingTargets(responseObject: GetSamplingTargetsResponse): void {
    try {
      const targetDocuments: TargetMap = {};

      // Create Target-Name-to-Target-Map from sampling targets response
      responseObject.SamplingTargetDocuments.forEach((newTarget: SamplingTargetDocument) => {
        targetDocuments[newTarget.RuleName] = newTarget;
      });

      // Update targets in the cache
      const [refreshSamplingRules, nextPollingInterval]: [boolean, number] = this.ruleCache.updateTargets(
        targetDocuments,
        responseObject.LastRuleModification
      );
      this.targetPollingInterval = nextPollingInterval;
      clearInterval(this.targetPoller);
      this.startSamplingTargetsPoller();

      if (refreshSamplingRules) {
        this.samplerDiag.debug('Performing out-of-band sampling rule polling to fetch updated rules.');
        clearInterval(this.rulePoller);
        this.startSamplingRulesPoller();
      }
    } catch (error: unknown) {
      this.samplerDiag.debug('Error occurred when updating Sampling Targets');
    }
  }

  private generateClientId(): string {
    const hexChars: string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
    const clientIdArray: string[] = [];
    for (let _: number = 0; _ < 24; _ += 1) {
      clientIdArray.push(hexChars[Math.floor(Math.random() * hexChars.length)]);
    }
    return clientIdArray.join('');
  }
}
