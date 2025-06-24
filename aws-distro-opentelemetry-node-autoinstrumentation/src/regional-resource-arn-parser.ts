// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue } from '@opentelemetry/api';
import { isAccountId } from './utils';

export class RegionalResourceArnParser {
  public static getAccountId(arn: AttributeValue | undefined): string | undefined {
    if (typeof arn == 'string' && this.isArn(arn)) {
      return arn.split(':')[4];
    }
    return undefined;
  }

  public static getRegion(arn: AttributeValue | undefined): string | undefined {
    if (typeof arn == 'string' && this.isArn(arn)) {
      return arn.split(':')[3];
    }
    return undefined;
  }

  public static isArn(arn: string): boolean {
    // Check if arn follows the format:
    // arn:partition:service:region:account-id:resource-type/resource-id or
    // arn:partition:service:region:account-id:resource-type:resource-id
    const arnParts = arn.split(':');
    return arnParts.length >= 6 && arnParts[0] === 'arn' && isAccountId(arnParts[4]);
  }
}
