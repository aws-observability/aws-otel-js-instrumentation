// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const major = +process.versions.node.split('.')[0];
if (major < 20) {
  console.log(`Skipping LangChain tests on Node ${process.version} (requires >= 20)`);
  process.exit(0);
}
