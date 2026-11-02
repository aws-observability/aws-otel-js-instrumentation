// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// ESM entry point for lite mode. On Node 24+ (and any ESM handler) the AWS SDK
// and user code are loaded as ES modules, which require-in-the-middle alone
// cannot intercept — so require-only lite instrumentation misses spans. This
// wrapper installs the import-in-the-middle loader hook first (same mechanism as
// the full SDK's wrapper.mjs), then runs the CJS lite bootstrap.
//
// Note: loading import-in-the-middle reintroduces the ESM hook cost that lite
// mode otherwise avoids, so the cold-start benefit on Node 24/ESM is smaller
// than on CJS. Correctness takes priority over the cold-start optimization here.
// https://github.com/nodejs/import-in-the-middle#only-intercepting-hooked-modules

import { register } from 'node:module';
import { Hook, createAddHookMessageChannel } from 'import-in-the-middle';

const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();

register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);

await waitForAllMessagesAcknowledged();

await import('/opt/lite-wrapper.js');
