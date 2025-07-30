// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue, Attributes, Context, Link, SpanKind } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { SamplingDecision, SamplingResult, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_CLIENT_ADDRESS,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_SERVER_ADDRESS,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  CLOUDPLATFORMVALUES_AWS_LAMBDA,
  SEMATTRS_AWS_LAMBDA_INVOKED_ARN,
  SEMATTRS_HTTP_HOST,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_TARGET,
  SEMATTRS_HTTP_URL,
  SEMRESATTRS_AWS_ECS_CLUSTER_ARN,
  SEMRESATTRS_AWS_ECS_CONTAINER_ARN,
  SEMRESATTRS_AWS_EKS_CLUSTER_ARN,
  SEMRESATTRS_CLOUD_PLATFORM,
  SEMRESATTRS_FAAS_ID,
  SEMRESATTRS_SERVICE_NAME,
} from '@opentelemetry/semantic-conventions';
import { RateLimitingSampler } from './rate-limiting-sampler';
import { ISamplingRule, ISamplingStatistics, SamplingTargetDocument } from './remote-sampler.types';
import { SamplingRule } from './sampling-rule';
import { Statistics } from './statistics';
import { CLOUD_PLATFORM_MAPPING, attributeMatch, wildcardMatch } from './utils';

// Max date time in JavaScript
const MAX_DATE_TIME_MILLIS: number = new Date(8_640_000_000_000_000).getTime();

export class SamplingRuleApplier {
  public samplingRule: SamplingRule;
  private reservoirSampler: RateLimitingSampler;
  private fixedRateSampler: TraceIdRatioBasedSampler;
  private statistics: Statistics;
  private borrowingEnabled: boolean;
  private reservoirExpiryTimeInMillis: number;

  constructor(samplingRule: ISamplingRule, statistics: Statistics = new Statistics(), target?: SamplingTargetDocument) {
    this.samplingRule = new SamplingRule(samplingRule);

    this.fixedRateSampler = new TraceIdRatioBasedSampler(this.samplingRule.FixedRate);
    if (samplingRule.ReservoirSize > 0) {
      this.reservoirSampler = new RateLimitingSampler(1);
    } else {
      this.reservoirSampler = new RateLimitingSampler(0);
    }

    this.reservoirExpiryTimeInMillis = MAX_DATE_TIME_MILLIS;
    this.statistics = statistics;
    this.statistics.resetStatistics();
    this.borrowingEnabled = true;

    if (target) {
      this.borrowingEnabled = false;
      if (typeof target.ReservoirQuota === 'number') {
        this.reservoirSampler = new RateLimitingSampler(target.ReservoirQuota);
      }

      if (typeof target.ReservoirQuotaTTL === 'number') {
        this.reservoirExpiryTimeInMillis = new Date(target.ReservoirQuotaTTL * 1000).getTime();
      } else {
        this.reservoirExpiryTimeInMillis = Date.now();
      }

      if (typeof target.FixedRate === 'number') {
        this.fixedRateSampler = new TraceIdRatioBasedSampler(target.FixedRate);
      }
    }
  }

  public withTarget(target: SamplingTargetDocument): SamplingRuleApplier {
    const newApplier: SamplingRuleApplier = new SamplingRuleApplier(this.samplingRule, this.statistics, target);
    return newApplier;
  }

  public matches(attributes: Attributes, resource: Resource): boolean {
    let httpTarget: AttributeValue | undefined = undefined;
    let httpUrl: AttributeValue | undefined = undefined;
    let httpMethod: AttributeValue | undefined = undefined;
    let httpHost: AttributeValue | undefined = undefined;
    let serviceName: AttributeValue | undefined = undefined;

    if (attributes) {
      httpTarget = attributes[SEMATTRS_HTTP_TARGET] ?? attributes[ATTR_URL_PATH];
      httpUrl = attributes[SEMATTRS_HTTP_URL] ?? attributes[ATTR_URL_FULL];
      httpMethod = attributes[SEMATTRS_HTTP_METHOD] ?? attributes[ATTR_HTTP_REQUEST_METHOD];
      httpHost = attributes[SEMATTRS_HTTP_HOST] ?? attributes[ATTR_SERVER_ADDRESS] ?? attributes[ATTR_CLIENT_ADDRESS];
    }

    let serviceType: AttributeValue | undefined = undefined;
    let resourceARN: AttributeValue | undefined = undefined;

    if (resource) {
      serviceName = resource.attributes[SEMRESATTRS_SERVICE_NAME] || '';
      const cloudPlatform: AttributeValue | undefined = resource.attributes[SEMRESATTRS_CLOUD_PLATFORM];
      if (typeof cloudPlatform === 'string') {
        serviceType = CLOUD_PLATFORM_MAPPING[cloudPlatform];
      }
      resourceARN = this.getArn(resource, attributes);
    }

    // target may be in url
    if (httpTarget === undefined && typeof httpUrl === 'string') {
      const schemeEndIndex: number = httpUrl.indexOf('://');
      // For network calls, URL usually has `scheme://host[:port][path][?query][#fragment]` format
      // Per spec, url.full is always populated with scheme://
      // If scheme is not present, assume it's bad instrumentation and ignore.
      if (schemeEndIndex > -1) {
        // urlparse("scheme://netloc/path;parameters?query#fragment")
        httpTarget = new URL(httpUrl).pathname;
        if (httpTarget === '') httpTarget = '/';
      }
    } else if (httpTarget === undefined && httpUrl === undefined) {
      // When missing, the URL Path is assumed to be '/'
      httpTarget = '/';
    }

    return (
      attributeMatch(attributes, this.samplingRule.Attributes) &&
      wildcardMatch(this.samplingRule.Host, httpHost) &&
      wildcardMatch(this.samplingRule.HTTPMethod, httpMethod) &&
      wildcardMatch(this.samplingRule.ServiceName, serviceName) &&
      wildcardMatch(this.samplingRule.URLPath, httpTarget) &&
      wildcardMatch(this.samplingRule.ServiceType, serviceType) &&
      wildcardMatch(this.samplingRule.ResourceARN, resourceARN)
    );
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    let hasBorrowed: boolean = false;
    let result: SamplingResult = { decision: SamplingDecision.NOT_RECORD };

    const nowInMillis: number = Date.now();
    const reservoirExpired: boolean = nowInMillis >= this.reservoirExpiryTimeInMillis;

    if (!reservoirExpired) {
      result = this.reservoirSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
      hasBorrowed = this.borrowingEnabled && result.decision !== SamplingDecision.NOT_RECORD;
    }

    if (result.decision === SamplingDecision.NOT_RECORD) {
      result = this.fixedRateSampler.shouldSample(context, traceId);
    }

    this.statistics.SampleCount += result.decision !== SamplingDecision.NOT_RECORD ? 1 : 0;
    this.statistics.BorrowCount += hasBorrowed ? 1 : 0;
    this.statistics.RequestCount += 1;

    return result;
  }

  public snapshotStatistics(): ISamplingStatistics {
    const statisticsCopy: ISamplingStatistics = { ...this.statistics };
    this.statistics.resetStatistics();
    return statisticsCopy;
  }

  private getArn(resource: Resource, attributes: Attributes): AttributeValue | undefined {
    let arn: AttributeValue | undefined =
      resource.attributes[SEMRESATTRS_AWS_ECS_CONTAINER_ARN] ||
      resource.attributes[SEMRESATTRS_AWS_ECS_CLUSTER_ARN] ||
      resource.attributes[SEMRESATTRS_AWS_EKS_CLUSTER_ARN];

    if (arn === undefined && resource?.attributes[SEMRESATTRS_CLOUD_PLATFORM] === CLOUDPLATFORMVALUES_AWS_LAMBDA) {
      arn = this.getLambdaArn(resource, attributes);
    }
    return arn;
  }

  private getLambdaArn(resource: Resource, attributes: Attributes): AttributeValue | undefined {
    const arn: AttributeValue | undefined =
      resource?.attributes[SEMRESATTRS_FAAS_ID] || attributes[SEMATTRS_AWS_LAMBDA_INVOKED_ARN];
    return arn;
  }
}
