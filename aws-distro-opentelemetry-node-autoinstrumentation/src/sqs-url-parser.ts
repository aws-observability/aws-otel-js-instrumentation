// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AttributeValue } from '@opentelemetry/api';
import { isAccountId } from './utils';

const HTTP_SCHEMA: string = 'http://';
const HTTPS_SCHEMA: string = 'https://';

// Cannot define type for regex variables
// eslint-disable-next-line @typescript-eslint/typedef
const ALPHABET_REGEX = /^[a-zA-Z]+$/;

export interface ParsedSqsUrl {
  queueName: string;
  accountId: string;
  region?: string;
}

export class SqsUrlParser {
  /**
   * Best-effort logic to extract queue name from an HTTP url. This method should only be used with
   * a string that is, with reasonably high confidence, an SQS queue URL. Handles new/legacy/some
   * custom URLs. Essentially, we require that the URL should have exactly three parts, delimited by
   * /'s (excluding schema), the second part should be a account id consisting of digits, and the third part
   * should be a valid queue name, per SQS naming conventions.
   */
  public static getQueueName(url: AttributeValue | undefined): string | undefined {
    if (typeof url !== 'string') {
      return undefined;
    }
    const urlWithoutProtocol = url.replace(HTTP_SCHEMA, '').replace(HTTPS_SCHEMA, '');
    const splitUrl: string[] = urlWithoutProtocol.split('/');
    if (splitUrl.length === 3 && isAccountId(splitUrl[1]) && this.isValidQueueName(splitUrl[2])) {
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

    const parsedUrl = this.parseUrl(url);
    return parsedUrl?.accountId;
  }

  /**
   * Extracts the region from an SQS URL.
   */
  public static getRegion(url: AttributeValue | undefined): string | undefined {
    if (typeof url !== 'string') {
      return undefined;
    }

    const parsedUrl = this.parseUrl(url);
    return parsedUrl?.region;
  }

  /**
   * Parses an SQS URL and extracts its components.
   * Format: https://sqs.<region>.amazonaws.com/<accountId>/<queueName>
   * @param url - The SQS URL to parse
   * @returns Object containing queue name, account ID and region, or undefined if invalid
   * @private
   */
  private static parseUrl(url: string): ParsedSqsUrl | undefined {
    const urlWithoutProtocol = url.replace(HTTP_SCHEMA, '').replace(HTTPS_SCHEMA, '');
    const splitUrl = urlWithoutProtocol.split('/');

    if (
      splitUrl.length !== 3 ||
      !splitUrl[0].toLowerCase().startsWith('sqs') ||
      !isAccountId(splitUrl[1]) ||
      !this.isValidQueueName(splitUrl[2])
    ) {
      return undefined;
    }

    const domain = splitUrl[0];
    const domainParts = domain.split('.');

    return {
      queueName: splitUrl[2],
      accountId: splitUrl[1],
      region: domainParts.length === 4 ? domainParts[1] : undefined,
    };
  }

  /**
   * Checks if the URL is a valid SQS URL.
   */
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
