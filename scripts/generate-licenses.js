#!/usr/bin/env node

const checker = require('license-checker-rseidelsohn');
const fs = require('fs');
const path = require('path');

const workspaceDir = path.join(__dirname, '..', 'aws-distro-opentelemetry-node-autoinstrumentation');

checker.init({
  start: workspaceDir,
  production: true,
  excludePrivatePackages: true,
  // Include packages from both local and hoisted node_modules
  includePackages: '',
  customFormat: {
    name: '',
    version: '',
    repository: '',
    licenseText: ''
  }
}, (err, packages) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }

  let output = '';
  const processedPackages = [];
  
  Object.keys(packages).forEach(packageKey => {
    const pkg = packages[packageKey];
    
    // Parse package name and version correctly for scoped packages
    let name, version;
    if (packageKey.startsWith('@')) {
      const lastAtIndex = packageKey.lastIndexOf('@');
      name = packageKey.substring(0, lastAtIndex);
      version = packageKey.substring(lastAtIndex + 1);
    } else {
      const atIndex = packageKey.indexOf('@');
      name = packageKey.substring(0, atIndex);
      version = packageKey.substring(atIndex + 1);
    }
    
    // Skip our own package
    if (name === '@aws/aws-distro-opentelemetry-node-autoinstrumentation') {
      return;
    }
    
    processedPackages.push({ name, version, pkg });
  });

  // Sort by package name for consistent output
  processedPackages.sort((a, b) => a.name.localeCompare(b.name));

  processedPackages.forEach(({ name, version, pkg }) => {
    output += `** ${name}; version ${version}`;
    if (pkg.repository) {
      output += ` -- ${pkg.repository}`;
    }
    output += '\n';
    
    if (pkg.licenseText) {
      output += pkg.licenseText + '\n\n';
    } else {
      output += 'License text not available\n\n';
    }
  });

  const outputPath = path.join(__dirname, '..', 'THIRD-PARTY-LICENSES');
  fs.writeFileSync(outputPath, output);
  console.log(`Generated THIRD-PARTY-LICENSES with ${processedPackages.length} packages`);
  
  // Also show what direct dependencies might be missing
  const workspacePackageJson = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, 'package.json'))
  );
  const directDeps = Object.keys(workspacePackageJson.dependencies || {});
  const foundPackages = new Set(processedPackages.map(p => p.name));
  const missingDeps = directDeps.filter(dep => !foundPackages.has(dep));
  
  if (missingDeps.length > 0) {
    console.log(`\nDirect dependencies without license files found: ${missingDeps.join(', ')}`);
  }
});
