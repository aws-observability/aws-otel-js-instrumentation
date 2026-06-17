// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AwsSpanProcessingUtil } from '../../aws-span-processing-util';

/**
 * Route label for a request that matched no framework route (unmatched 404s, scanner/bot
 * traffic to nonexistent URLs like /wp-admin or /.env).
 *
 * Recording the raw path for these would make every probed URL its own metric series — a
 * cardinality explosion. Instead, collapse to the first path segment, e.g.
 * "/wp-admin/setup.php" -> "/wp-admin". This is exactly what Application Signals does for a
 * span whose name can't be resolved to a route (AwsSpanProcessingUtil.extractAPIPathValue),
 * so ServiceEvents and Application Signals produce the same operation label for unmatched
 * requests, identically across the Express/Fastify/Koa/Next.js instrumentations. The
 * delegated helper also strips any query/fragment, so a raw URL like "/wp-admin/x?a=1"
 * still collapses to "/wp-admin".
 *
 * Keeping this in one module makes cross-framework behavior structural rather than a promise
 * enforced by comments — a single edit here changes every framework at once.
 */
export function unmatchedRouteLabel(rawPath: string | undefined | null): string {
  return AwsSpanProcessingUtil.extractAPIPathValue(rawPath);
}
