// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Only intercepts instrumentation libraries loaded from Otel SDK
// https://github.com/nodejs/import-in-the-middle#only-intercepting-hooked-modules

import { register } from 'node:module';
import { Hook, createAddHookMessageChannel } from 'import-in-the-middle';

const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();

register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);

await waitForAllMessagesAcknowledged();

await import('/opt/wrapper.js');
