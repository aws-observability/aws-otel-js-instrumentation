// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export { installExpressHooks, installGlobalHttpPatches } from './express-instrumentation';
export { installFastifyHooks, installFastifyLifecycleHooks } from './fastify-instrumentation';
export { installKoaHooks, installKoaMiddleware } from './koa-instrumentation';
export { installNextJsHooks } from './nextjs-instrumentation';
