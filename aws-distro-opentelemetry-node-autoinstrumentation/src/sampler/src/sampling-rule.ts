// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ISamplingRule } from './remote-sampler.types';

export class SamplingRule implements ISamplingRule {
  public RuleName: string;
  public RuleARN: string | undefined;
  public Priority: number;
  public ReservoirSize: number;
  public FixedRate: number;
  public ServiceName: string;
  public ServiceType: string;
  public Host: string;
  public HTTPMethod: string;
  public URLPath: string;
  public ResourceARN: string;
  public Attributes: { [key: string]: string } | undefined;
  public Version: number;

  constructor(samplingRule: ISamplingRule) {
    // The AWS API docs mark `RuleName` as an optional field but in practice it seems to always be
    // present, and sampling targets could not be computed without it. For now provide an arbitrary fallback just in
    // case the AWS API docs are correct.
    this.RuleName = samplingRule.RuleName ? samplingRule.RuleName : 'Default';
    this.RuleARN = samplingRule.RuleARN;
    this.Priority = samplingRule.Priority;
    this.ReservoirSize = samplingRule.ReservoirSize;
    this.FixedRate = samplingRule.FixedRate;
    this.ServiceName = samplingRule.ServiceName;
    this.ServiceType = samplingRule.ServiceType;
    this.Host = samplingRule.Host;
    this.HTTPMethod = samplingRule.HTTPMethod;
    this.URLPath = samplingRule.URLPath;
    this.ResourceARN = samplingRule.ResourceARN;
    this.Version = samplingRule.Version;
    this.Attributes = samplingRule.Attributes;
  }

  public equals(other: ISamplingRule): boolean {
    let attributesEquals: boolean;

    if (this.Attributes === undefined || other.Attributes === undefined) {
      attributesEquals = this.Attributes === other.Attributes;
    } else {
      attributesEquals = this.Attributes.length === other.Attributes.length;
      for (const attributeKey in other.Attributes) {
        if (!(attributeKey in this.Attributes) || this.Attributes[attributeKey] !== other.Attributes[attributeKey]) {
          attributesEquals = false;
          break;
        }
      }
    }

    return (
      this.FixedRate === other.FixedRate &&
      this.HTTPMethod === other.HTTPMethod &&
      this.Host === other.Host &&
      this.Priority === other.Priority &&
      this.ReservoirSize === other.ReservoirSize &&
      this.ResourceARN === other.ResourceARN &&
      this.RuleARN === other.RuleARN &&
      this.RuleName === other.RuleName &&
      this.ServiceName === other.ServiceName &&
      this.ServiceType === other.ServiceType &&
      this.URLPath === other.URLPath &&
      this.Version === other.Version &&
      attributesEquals
    );
  }
}
