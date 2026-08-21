// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as path from 'path';

export function getInstalledPackageVersion(packageName: string): string {
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    const packageJsonPath = path.join(searchPath, packageName, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.name === packageName && typeof packageJson.version === 'string') {
        return packageJson.version;
      }
    }
  }

  try {
    const entryPoint = require.resolve(packageName);
    let directory = path.dirname(entryPoint);
    while (directory !== path.dirname(directory)) {
      const packageJsonPath = path.join(directory, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.name === packageName && typeof packageJson.version === 'string') {
          return packageJson.version;
        }
      }
      directory = path.dirname(directory);
    }
  } catch {
    // Some packages expose only subpaths and cannot be resolved from their package root.
  }

  throw new Error(`Could not find package.json for ${packageName}`);
}

export function reportCompatibilityDependency(packageName: string): string {
  const version = getInstalledPackageVersion(packageName);
  console.log(`Testing compatibility with ${packageName}@${version}`);
  return version;
}
