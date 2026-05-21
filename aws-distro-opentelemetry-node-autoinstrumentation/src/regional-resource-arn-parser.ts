// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue } from '@opentelemetry/api';
import { isAccountId } from './utils';

export class RegionalResourceArnParser {
  /** Parses ARN with formats:
   * arn:partition:service:region:account-id:resource-type/resource-id or
   * arn:partition:service:region:account-id:resource-type:resource-id
   */
  private static parseArn(arn: AttributeValue | undefined): string[] | undefined {
    if (typeof arn !== 'string') return undefined;
    const parts = arn.split(':');
    return parts.length >= 6 && parts[0] === 'arn' && isAccountId(parts[4]) ? parts : undefined;
  }

  public static getAccountId(arn: AttributeValue | undefined): string | undefined {
    return this.parseArn(arn)?.[4];
  }

  public static getRegion(arn: AttributeValue | undefined): string | undefined {
    return this.parseArn(arn)?.[3];
  }

  public static extractDynamoDbTableNameFromArn(arn: AttributeValue | undefined): string | undefined {
    return this.extractResourceNameFromArn(arn)?.replace('table/', '');
  }

  public static extractKinesisStreamNameFromArn(arn: AttributeValue | undefined): string | undefined {
    return this.extractResourceNameFromArn(arn)?.replace('stream/', '');
  }

  public static extractResourceNameFromArn(arn: AttributeValue | undefined): string | undefined {
    const parts = this.parseArn(arn);
    return parts?.[parts.length - 1];
  }

  /**
   * Extract resource ID from a Bedrock AgentCore ARN.
   * AgentCore ARNs have the format: arn:partition:service:region:account:resource-type/resource-id
   * This extracts the last segment after the final '/'.
   */
  public static extractBedrockAgentCoreResourceIdFromArn(arn: AttributeValue | undefined): string | undefined {
    const resourcePart = this.extractResourceNameFromArn(arn);
    if (resourcePart === undefined) {
      return undefined;
    }
    const parts = resourcePart.split('/');
    return parts[parts.length - 1] || undefined;
  }
}
