// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue } from '@opentelemetry/api';

const HTTP_SCHEMA: string = 'http://';
const HTTPS_SCHEMA: string = 'https://';

// Cannot define type for regex variables
// eslint-disable-next-line @typescript-eslint/typedef
const ALPHABET_REGEX = /^[a-zA-Z]+$/;

export class SqsUrlParser {
  /**
   * Best-effort logic to extract queue name from an HTTP url. This method should only be used with
   * a string that is, with reasonably high confidence, an SQS queue URL. Handles new/legacy/some
   * custom URLs. Essentially, we require that the URL should have exactly three parts, delimited by
   * /'s (excluding schema), the second part should be a 12-digit account id, and the third part
   * should be a valid queue name, per SQS naming conventions.
   */
  public static getQueueName(url: AttributeValue | undefined): string | undefined {
    if (typeof url !== 'string') {
      return undefined;
    }
    url = url.replace(HTTP_SCHEMA, '').replace(HTTPS_SCHEMA, '');
    const splitUrl: string[] = url.split('/');
    if (splitUrl.length === 3 && this.isAccountId(splitUrl[1]) && this.isValidQueueName(splitUrl[2])) {
      return splitUrl[2];
    }
    return undefined;
  }

  /**
   * Extracts the account ID from an SQS URL.
   */
  public static getAccountId(url: AttributeValue | undefined): string | undefined {
    if (typeof url !== 'string') {
      return undefined;
    }

    url = url.replace(HTTP_SCHEMA, '').replace(HTTPS_SCHEMA, '');
    if (this.isValidSqsUrl(url)) {
      const splitUrl: string[] = url.split('/');
      return splitUrl[1];
    }

    return undefined;
  }

  /**
   * Extracts the region from an SQS URL.
   */
  public static getRegion(url: AttributeValue | undefined): string | undefined {
    if (typeof url !== 'string') {
      return undefined;
    }

    url = url.replace(HTTP_SCHEMA, '').replace(HTTPS_SCHEMA, '');
    if (this.isValidSqsUrl(url)) {
      const splitUrl: string[] = url.split('/');
      const domain: string = splitUrl[0];
      const domainParts: string[] = domain.split('.');
      if (domainParts.length === 4) {
        return domainParts[1];
      }
    }

    return undefined;
  }

  /**
   * Checks if the URL is a valid SQS URL.
   */
  private static isValidSqsUrl(url: string): boolean {
    const splitUrl: string[] = url.split('/');
    return (
      splitUrl.length === 3 &&
      splitUrl[0].toLowerCase().startsWith('sqs') &&
      this.isAccountId(splitUrl[1]) &&
      this.isValidQueueName(splitUrl[2])
    );
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

  private static isValidQueueName(input: string): boolean {
    if (input == null || input.length === 0 || input.length > 80) {
      return false;
    }

    for (let i: number = 0; i < input.length; i++) {
      const c: string = input.charAt(i);
      if (c !== '_' && c !== '-' && !ALPHABET_REGEX.test(c) && !(c >= '0' && c <= '9')) {
        return false;
      }
    }

    return true;
  }
}
