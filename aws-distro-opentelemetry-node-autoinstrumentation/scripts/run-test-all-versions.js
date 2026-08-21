// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const OMITTED_DEPENDENCIES = [/^@ai-sdk\//, /^@langchain\//, /^@openai\/agents/, /^ai$/, /^zod$/];
const DEFAULT_TAV_TARGETS = ['@langchain/core', '@openai/agents', 'ai'];

function runNpm(args, cwd, env = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error('npm_execpath is not set; run this script through npm');
  }

  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function shouldCopy(source) {
  const relative = path.relative(PACKAGE_ROOT, source);
  if (!relative) return true;

  return !relative
    .split(path.sep)
    .some(segment => segment === 'node_modules' || segment === 'build' || segment === 'coverage');
}

function removeCompatibilityDependencies(dependencies = {}) {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => !OMITTED_DEPENDENCIES.some(pattern => pattern.test(name)))
  );
}

function runTarget(target) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adot-js-tav-'));
  console.log(`Running ${target} unit tests in ${tempRoot}`);

  try {
    fs.cpSync(PACKAGE_ROOT, tempRoot, {
      recursive: true,
      filter: shouldCopy,
    });

    const packageJsonPath = path.join(tempRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    packageJson.dependencies = removeCompatibilityDependencies(packageJson.dependencies);
    packageJson.devDependencies = removeCompatibilityDependencies(packageJson.devDependencies);
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    runNpm(['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'], tempRoot);
    runNpm(['run', 'create-version'], tempRoot);
    runNpm(['run', 'test-all-versions:isolated'], tempRoot, { TAV: target });
  } finally {
    if (process.env.KEEP_TAV_TMP === '1') {
      console.log(`Keeping dependency test workspace at ${tempRoot}`);
    } else {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

const targets = process.env.TAV ? process.env.TAV.split(',').map(target => target.trim()) : DEFAULT_TAV_TARGETS;
for (const target of targets.filter(Boolean)) {
  runTarget(target);
}
