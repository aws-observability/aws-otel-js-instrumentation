/*
 * Copyright Amazon.com, Inc. or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

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
  public static getQueueName(url: string | undefined): string | undefined {
    if (url == undefined) {
      return undefined;
    }
    url = url.replace(HTTP_SCHEMA, '').replace(HTTPS_SCHEMA, '');
    const splitUrl: string[] = url.split('/');
    if (splitUrl.length == 3 && this.isAccountId(splitUrl[1]) && this.isValidQueueName(splitUrl[2])) {
      return splitUrl[2];
    }
    return undefined;
  }

  private static isAccountId(input: string): boolean {
    if (input == null || input.length != 12) {
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
    if (input == null || input.length == 0 || input.length > 80) {
      return false;
    }

    for (let i: number = 0; i < input.length; i++) {
      const c: string = input.charAt(i);
      if (c != '_' && c != '-' && !ALPHABET_REGEX.test(c) && !(c >= '0' && c <= '9')) {
        return false;
      }
    }

    return true;
  }
}
