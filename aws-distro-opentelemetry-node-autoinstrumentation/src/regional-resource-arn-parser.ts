// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue } from '@opentelemetry/api';

export class RegionalResourceArnParser {
  public static getAccountId(arn: AttributeValue | undefined): string | undefined {
    if (this.isArn(arn)) {
      return (arn! as string).split(':')[4];
    }
    return undefined;
  }

  public static getRegion(arn: AttributeValue | undefined): string | undefined {
    if (this.isArn(arn)) {
      return (arn! as string).split(':')[3];
    }
    return undefined;
  }

  public static isArn(arn: AttributeValue | undefined): boolean {
    // Check if arn follows the format:
    // arn:partition:service:region:account-id:resource-type/resource-id or
    // arn:partition:service:region:account-id:resource-type:resource-id
    if (!arn || typeof arn !== 'string') {
      return false;
    }

    if (!arn.startsWith('arn')) {
      return false;
    }

    const arnParts = arn.split(':');
    return arnParts.length >= 6 && this.isAccountId(arnParts[4]);
  }

  private static isAccountId(input: string): boolean {
    if (input == null || input.length !== 12) {
      return false;
    }

    if (!this._checkDigits(input)) {
      return false;
    }

    return true;
  }

  private static _checkDigits(str: string): boolean {
    return /^\d+$/.test(str);
  }
}
