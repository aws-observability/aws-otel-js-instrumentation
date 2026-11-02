// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';

const REPO_TS_NODE = require.resolve('ts-node/register');

// Runs a contract-test app to completion as a child process (real bootstrap: --require chain,
// NodeSDK init, auto-instrumentations). Returns when the app exits (it self-drives and exits).
//
// Mode 1 (zero-code) must run as built JS under plain node: the --require chain loads our built
// register, which patches the sdk-node instance that upstream register then constructs. Running the
// app under ts-node would load a second (source) copy of sdk-node, defeating the module-cache patch.
export function runApp(opts: {
  app: string; // app entrypoint basename under contract-tests/apps (no extension)
  requires?: string[]; // modules to --require before the app (Mode 1 patch chain)
  env: Record<string, string>;
  appPort: number;
  collectorEndpoint: string;
  drivePath?: string;
  builtJs?: boolean; // run built JS under plain node (Mode 1); otherwise ts-node
}): Promise<number> {
  const useBuilt = opts.builtJs ?? false;
  const nodeArgs: string[] = [];
  if (!useBuilt) {
    nodeArgs.push('-r', REPO_TS_NODE);
  }
  for (const r of opts.requires ?? []) {
    nodeArgs.push('-r', r);
  }
  // __dirname is contract-tests/e2e/utils. Built apps land at build/contract-tests/apps (rootDir=.);
  // ts-node runs the .ts sources at contract-tests/apps.
  const appDir = useBuilt
    ? path.resolve(__dirname, '..', '..', '..', 'build', 'contract-tests', 'apps')
    : path.resolve(__dirname, '..', '..', 'apps');
  nodeArgs.push(path.join(appDir, opts.app + (useBuilt ? '.js' : '.ts')));

  const child: ChildProcess = spawn(process.execPath, nodeArgs, {
    env: {
      ...process.env,
      TS_NODE_PROJECT: path.resolve(__dirname, '..', '..', '..', 'tsconfig.json'),
      APP_PORT: String(opts.appPort),
      COLLECTOR_ENDPOINT: opts.collectorEndpoint,
      DRIVE_PATH: opts.drivePath ?? '/items/42',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', d => (stderr += d));

  return new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`app ${opts.app} exited ${code}\n${stderr.slice(-2000)}`));
      } else {
        resolve(code ?? 0);
      }
    });
  });
}
