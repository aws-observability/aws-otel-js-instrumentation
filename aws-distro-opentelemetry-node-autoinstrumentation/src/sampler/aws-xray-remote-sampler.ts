// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, Context, DiagLogger, Link, SpanKind, TraceFlags, createTraceState, diag, trace } from '@opentelemetry/api';
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
import { DEFAULT_TARGET_POLLING_INTERVAL_SECONDS, RuleCache, XRSR_TRACE_STATE_KEY } from './rule-cache';
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

    // Only count stats for root spans (spans whose sampling decision was made by this service)
    // Python: _rule_cache.py line 211 — "not span.parent.is_valid"
    if (span.parentSpanContext?.spanId) {
      return;
    }

    const isSampled = (span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0;
    const traceId = span.spanContext().traceId;

    // Resolve the effective rule applier
    // First try xrsr from traceState (for downstream services receiving propagated context)
    // For local root spans, traceState on spanContext is empty — fall back to rule matching
    // Python: _rule_cache.py lines 197-214
    const xrsrHash = span.spanContext().traceState?.get(XRSR_TRACE_STATE_KEY);
    let effectiveApplier = xrsrHash ? this.ruleCache.getRuleApplierByHash(xrsrHash) : undefined;
    if (!effectiveApplier) {
      effectiveApplier = this.ruleCache.getMatchedRule(span.attributes);
    }

    if (effectiveApplier) {
      effectiveApplier.countTrace(traceId);
    }

    const match = this.anomalyDetector.getAnomalyMatch(span);
    if (match) {
      if (match.forBoost && effectiveApplier) {
        effectiveApplier.countAnomalyTrace(isSampled);
      }
      if (match.forCapture && !isSampled && this.spanBatcher && this.anomalyDetector.shouldCaptureAnomaly(traceId)) {
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
    let matchedRuleName: string | undefined;

    if (this.ruleCache.isExpired()) {
      this.samplerDiag.debug('Rule cache is expired, so using fallback sampling strategy');
      result = this.fallbackSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
    } else {
      const matchedRule: SamplingRuleApplier | undefined = this.ruleCache.getMatchedRule(attributes);
      if (matchedRule) {
        result = matchedRule.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        matchedRuleName = matchedRule.samplingRule.RuleName;
      } else {
        this.samplerDiag.debug(
          'Using fallback sampler as no rule match was found. This is likely due to a bug, since default rule should always match'
        );
        result = this.fallbackSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
      }
    }

    // Determine xrsr tracestate value to propagate
    // Python: _rule_cache.py lines 82-111
    const parentSpanContext = trace.getSpan(context)?.spanContext();
    const upstreamXrsr = parentSpanContext?.traceState?.get(XRSR_TRACE_STATE_KEY);

    let hashedRuleName: string | undefined;
    if (upstreamXrsr) {
      // Downstream service: propagate upstream's hash unchanged
      hashedRuleName = upstreamXrsr;
    } else if (parentSpanContext?.spanId) {
      // Child span with valid parent but no upstream xrsr: don't set new xrsr
      hashedRuleName = undefined;
    } else if (matchedRuleName) {
      // Root span: set xrsr to hash of our matched rule
      hashedRuleName = this.ruleCache.getHashForRule(matchedRuleName);
    }

    // Build traceState with xrsr (only if not already present)
    // Python: _aws_sampling_result.py lines 39-42
    let traceState = result.traceState ?? createTraceState();
    if (hashedRuleName && !traceState.get(XRSR_TRACE_STATE_KEY)) {
      traceState = traceState.set(XRSR_TRACE_STATE_KEY, hashedRuleName);
    }

    const finalAttributes = this.anomalyDetector
      ? { ...result.attributes, [AWS_XRAY_ADAPTIVE_SAMPLING_CONFIGURED_ATTRIBUTE]: 'true' }
      : result.attributes;

    return {
      decision: result.decision,
      attributes: finalAttributes,
      traceState,
    };
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

    // Collect per-rule boost stats (Python: _rule_cache.py lines 383-393)
    if (this.anomalyDetector) {
      const boostDocs = this.ruleCache.createBoostStatisticsDocuments(this.clientId, this.serviceName);
      if (boostDocs.length > 0) {
        requestBody.SamplingBoostStatisticsDocuments = boostDocs;
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
