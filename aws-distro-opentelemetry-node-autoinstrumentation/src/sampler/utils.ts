// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue, Attributes, diag } from '@opentelemetry/api';
import {
  CLOUDPLATFORMVALUES_AWS_EC2,
  CLOUDPLATFORMVALUES_AWS_ECS,
  CLOUDPLATFORMVALUES_AWS_EKS,
  CLOUDPLATFORMVALUES_AWS_ELASTIC_BEANSTALK,
  CLOUDPLATFORMVALUES_AWS_LAMBDA,
} from '@opentelemetry/semantic-conventions';

export const CLOUD_PLATFORM_MAPPING: { [cloudPlatformKey: string]: string } = {
  [CLOUDPLATFORMVALUES_AWS_LAMBDA]: 'AWS::Lambda::Function',
  [CLOUDPLATFORMVALUES_AWS_ELASTIC_BEANSTALK]: 'AWS::ElasticBeanstalk::Environment',
  [CLOUDPLATFORMVALUES_AWS_EC2]: 'AWS::EC2::Instance',
  [CLOUDPLATFORMVALUES_AWS_ECS]: 'AWS::ECS::Container',
  [CLOUDPLATFORMVALUES_AWS_EKS]: 'AWS::EKS::Container',
};

// Template function from: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
function escapeRegExp(regExPattern: string): string {
  // removed * and ? so they don't get escaped to maintain them as a wildcard match
  return regExPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function convertPatternToRegExp(pattern: string): string {
  return escapeRegExp(pattern).replace(/\*/g, '.*').replace(/\?/g, '.');
}

export function wildcardMatch(pattern?: string, text?: AttributeValue): boolean {
  if (pattern === '*') return true;
  if (pattern === undefined || typeof text !== 'string') return false;
  if (pattern.length === 0) return text.length === 0;

  const match: RegExpMatchArray | null = text.toLowerCase().match(`^${convertPatternToRegExp(pattern.toLowerCase())}$`);

  if (match === null) {
    diag.debug(`WildcardMatch: no match found for ${text} against pattern ${pattern}`);
    return false;
  }

  return true;
}

export function attributeMatch(
  attributes: Attributes | undefined,
  ruleAttributes: { [key: string]: string } | undefined
): boolean {
  if (!ruleAttributes || Object.keys(ruleAttributes).length === 0) {
    return true;
  }

  if (
    attributes === undefined ||
    Object.keys(attributes).length === 0 ||
    Object.keys(ruleAttributes).length > Object.keys(attributes).length
  ) {
    return false;
  }

  let matchedCount: number = 0;
  for (const [key, value] of Object.entries(attributes)) {
    const foundKey: string | undefined = Object.keys(ruleAttributes).find(ruleKey => ruleKey === key);

    if (foundKey === undefined) {
      continue;
    }

    if (wildcardMatch(ruleAttributes[foundKey], value)) {
      // increment matched count
      matchedCount += 1;
    }
  }

  return matchedCount === Object.keys(ruleAttributes).length;
}
