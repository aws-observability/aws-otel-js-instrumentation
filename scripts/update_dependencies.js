#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

async function getLatestVersion(packageName) {
  const https = require('https');
  
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${packageName}/latest`;
    const request = https.get(url, { timeout: 30000 }, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        try {
          if (response.statusCode === 200) {
            const packageData = JSON.parse(data);
            resolve(packageData.version);
          } else {
            console.warn(`Warning: Could not get latest version for ${packageName}: HTTP ${response.statusCode}`);
            resolve(null);
          }
        } catch (parseError) {
          console.warn(`Warning: Could not parse response for ${packageName}: ${parseError.message}`);
          resolve(null);
        }
      });
    });
    
    request.on('error', (requestError) => {
      console.warn(`Warning: Could not get latest version for ${packageName}: ${requestError.message}`);
      resolve(null);
    });
    
    request.on('timeout', () => {
      request.destroy();
      console.warn(`Warning: Timeout getting latest version for ${packageName}`);
      resolve(null);
    });
  });
}

async function main() {
  const packageJsonPath = path.join('aws-distro-opentelemetry-node-autoinstrumentation', 'package.json');
  
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    let updated = false;
    
    const dependencies = packageJson.dependencies || {};
    const otelPackages = Object.keys(dependencies).filter(pkg => pkg.startsWith('@opentelemetry/'));
    
    for (const packageName of otelPackages) {
      const latestVersion = await getLatestVersion(packageName);
      if (latestVersion) {
        const currentVersion = dependencies[packageName];
        
        if (currentVersion !== latestVersion) {
          packageJson.dependencies[packageName] = latestVersion;
          updated = true;
          console.log(`Updated ${packageName}: ${currentVersion} → ${latestVersion}`);
        } else {
          console.log(`${packageName} already at latest version: ${latestVersion}`);
        }
      }
    }
    
    if (updated) {
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
      console.log('Dependencies updated successfully');
    } else {
      console.log('No OpenTelemetry dependencies needed updating');
    }
    
  } catch (fileError) {
    console.error(`Error updating dependencies: ${fileError.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
