// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, Context, DiagLogger, Link, SpanKind, TraceFlags, diag } from '@opentelemetry/api';
import { ParentBasedSampler, ReadableSpan, Sampler, SamplingResult } from '@opentelemetry/sdk-trace-base';
import { AdaptiveSamplingConfig } from './adaptive-sampling-config';
import { AnomalyDetector, AWS_XRAY_ADAPTIVE_SAMPLING_CONFIGURED_ATTRIBUTE } from './anomaly-detector';
import { AwsXraySamplingClient } from './aws-xray-sampling-client';
import { FallbackSampler } from './fallback-sampler';
import {
  AwsXRayRemoteSamplerConfig,
  GetSamplingRulesResponse,
  GetSamplingTargetsBody,
  GetSamplingTargetsResponse,
  SamplingRuleRecord,
  SamplingTargetDocument,
  TargetMap,
} from './remote-sampler.types';
import { DEFAULT_TARGET_POLLING_INTERVAL_SECONDS, RuleCache } from './rule-cache';
import { SamplingRuleApplier } from './sampling-rule-applier';

// 5 minute default sampling rules polling interval
const DEFAULT_RULES_POLLING_INTERVAL_SECONDS: number = 5 * 60;
// Default endpoint for awsproxy : https://aws-otel.github.io/docs/getting-started/remote-sampling#enable-awsproxy-extension
const DEFAULT_AWS_PROXY_ENDPOINT: string = 'http://localhost:2000';

// Wrapper class to ensure that all XRay Sampler Functionality in _AwsXRayRemoteSampler
// uses ParentBased logic to respect the parent span's sampling decision
export class AwsXRayRemoteSampler implements Sampler {
  private _root: ParentBasedSampler;
  private _inner: _AwsXRayRemoteSampler;

  constructor(samplerConfig: AwsXRayRemoteSamplerConfig) {
    this._inner = new _AwsXRayRemoteSampler(samplerConfig);
    this._root = new ParentBasedSampler({ root: this._inner });
  }

  public shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    return this._root.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  public setAdaptiveSamplingConfig(config: AdaptiveSamplingConfig): void {
    this._inner.setAdaptiveSamplingConfig(config);
  }

  public setSpanBatcher(batcher: (span: ReadableSpan) => void): void {
    this._inner.setSpanBatcher(batcher);
  }

  public adaptSampling(span: ReadableSpan): void {
    this._inner.adaptSampling(span);
  }

  public toString(): string {
    return `AwsXRayRemoteSampler{root=${this._root.toString()}`;
  }
}

// _AwsXRayRemoteSampler contains all core XRay Sampler Functionality,
// however it is NOT Parent-based (e.g. Sample logic runs for each span)
// Not intended for external use, use Parent-based `AwsXRayRemoteSampler` instead.
export class _AwsXRayRemoteSampler implements Sampler {
  private rulePollingIntervalMillis: number;
  private targetPollingInterval: number;
  private awsProxyEndpoint: string;
  private ruleCache: RuleCache;
  private fallbackSampler: FallbackSampler;
  private samplerDiag: DiagLogger;
  private rulePoller: NodeJS.Timer | undefined;
  private targetPoller: NodeJS.Timer | undefined;
  private clientId: string;
  private rulePollingJitterMillis: number;
  private targetPollingJitterMillis: number;
  private samplingClient: AwsXraySamplingClient;
  private anomalyDetector: AnomalyDetector | undefined;
  private spanBatcher: ((span: ReadableSpan) => void) | undefined;
  private serviceName: string;

  constructor(samplerConfig: AwsXRayRemoteSamplerConfig) {
    this.samplerDiag = diag;

    if (samplerConfig.pollingInterval == null || samplerConfig.pollingInterval < 10) {
      this.samplerDiag.warn(
        `'pollingInterval' is undefined or too small. Defaulting to ${DEFAULT_RULES_POLLING_INTERVAL_SECONDS} seconds`
      );
      this.rulePollingIntervalMillis = DEFAULT_RULES_POLLING_INTERVAL_SECONDS * 1000;
    } else {
      this.rulePollingIntervalMillis = samplerConfig.pollingInterval * 1000;
    }

    this.rulePollingJitterMillis = Math.random() * 5 * 1000;
    this.targetPollingInterval = this.getDefaultTargetPollingInterval();
    this.targetPollingJitterMillis = (Math.random() / 10) * 1000;

    this.awsProxyEndpoint = samplerConfig.endpoint ? samplerConfig.endpoint : DEFAULT_AWS_PROXY_ENDPOINT;
    this.fallbackSampler = new FallbackSampler();
    this.clientId = _AwsXRayRemoteSampler.generateClientId();
    this.ruleCache = new RuleCache(samplerConfig.resource);
    this.serviceName = String(samplerConfig.resource.attributes['service.name'] || '');

    this.samplingClient = new AwsXraySamplingClient(this.awsProxyEndpoint, this.samplerDiag);

    // Start the Sampling Rules poller
    this.startSamplingRulesPoller();

    // Start the Sampling Targets poller where the first poll occurs after the default interval
    this.startSamplingTargetsPoller();
  }

  public getDefaultTargetPollingInterval(): number {
    return DEFAULT_TARGET_POLLING_INTERVAL_SECONDS;
  }

  public setAdaptiveSamplingConfig(config: AdaptiveSamplingConfig): void {
    this.anomalyDetector = new AnomalyDetector(config);
    this.samplerDiag.info('Adaptive sampling enabled');
  }

  public setSpanBatcher(batcher: (span: ReadableSpan) => void): void {
    this.spanBatcher = batcher;
  }

  public adaptSampling(span: ReadableSpan): void {
    if (!this.anomalyDetector) {
      return;
    }

    const isSampled = (span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0;
    const traceId = span.spanContext().traceId;

    this.anomalyDetector.recordTrace();

    if (this.anomalyDetector.isAnomaly(span)) {
      this.anomalyDetector.recordAnomaly(isSampled);

      if (!isSampled && this.spanBatcher && this.anomalyDetector.shouldCaptureAnomaly(traceId)) {
        this.spanBatcher(span);
      }
    }
  }

  public shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    let result: SamplingResult;

    if (this.ruleCache.isExpired()) {
      this.samplerDiag.debug('Rule cache is expired, so using fallback sampling strategy');
      result = this.fallbackSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
    } else {
      const matchedRule: SamplingRuleApplier | undefined = this.ruleCache.getMatchedRule(attributes);
      if (matchedRule) {
        result = matchedRule.shouldSample(context, traceId, spanName, spanKind, attributes, links);
      } else {
        this.samplerDiag.debug(
          'Using fallback sampler as no rule match was found. This is likely due to a bug, since default rule should always match'
        );
        result = this.fallbackSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
      }
    }

    if (this.anomalyDetector) {
      return {
        decision: result.decision,
        attributes: {
          ...result.attributes,
          [AWS_XRAY_ADAPTIVE_SAMPLING_CONFIGURED_ATTRIBUTE]: 'true',
        },
        traceState: result.traceState,
      };
    }

    return result;
  }

  public toString(): string {
    return `_AwsXRayRemoteSampler{awsProxyEndpoint=${
      this.awsProxyEndpoint
    }, rulePollingIntervalMillis=${this.rulePollingIntervalMillis.toString()}}`;
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

    if (this.anomalyDetector) {
      const boostStats = this.anomalyDetector.snapshotAndResetStatistics();
      if (boostStats.TotalCount > 0) {
        requestBody.SamplingBoostStatisticsDocuments = [
          {
            ClientID: this.clientId,
            RuleName: 'Default',
            ServiceName: this.serviceName,
            Timestamp: Math.floor(Date.now() / 1000),
            TotalCount: boostStats.TotalCount,
            AnomalyCount: boostStats.AnomalyCount,
            SampledAnomalyCount: boostStats.SampledAnomalyCount,
          },
        ];
      }
    }

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

  private static generateClientId(): string {
    const hexChars: string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
    const clientIdArray: string[] = [];
    for (let _: number = 0; _ < 24; _ += 1) {
      clientIdArray.push(hexChars[Math.floor(Math.random() * hexChars.length)]);
    }
    return clientIdArray.join('');
  }
}
