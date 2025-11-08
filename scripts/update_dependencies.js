#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getLatestOtelVersions } = require('./get_upstream_versions.js');

async function httpsGet(url) {
  const https = require('https');
  
  return new Promise((resolve, reject) => {
    const options = {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Node.js script)'
      }
    };
    
    const request = https.get(url, options, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        try {
          if (response.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            console.warn(`Warning: HTTP ${response.statusCode} for ${url}`);
            resolve(null);
          }
        } catch (parseError) {
          console.warn(`Warning: Could not parse response for ${url}: ${parseError.message}`);
          resolve(null);
        }
      });
    });
    
    request.on('error', (requestError) => {
      console.warn(`Warning: Request failed for ${url}: ${requestError.message}`);
      resolve(null);
    });
    
    request.on('timeout', () => {
      request.destroy();
      console.warn(`Warning: Timeout for ${url}`);
      resolve(null);
    });
  });
}

async function getLatestVersionFromNpm(packageName) {
  try {
    const data = await httpsGet(`https://registry.npmjs.org/${packageName}/latest`);
    return data ? data.version : null;
  } catch (error) {
    console.warn(`Warning: Could not get npm version for ${packageName}: ${error.message}`);
    return null;
  }
}

// Package categorization based on their typical versioning patterns
const PACKAGE_CATEGORIES = {
  api: ['@opentelemetry/api'],
  core: [
    '@opentelemetry/core',
    '@opentelemetry/exporter-zipkin',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/sdk-trace-base'
  ],
  experimental: [
    '@opentelemetry/api-events',
    '@opentelemetry/exporter-metrics-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-trace-otlp-proto',
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/exporter-logs-otlp-http',
    '@opentelemetry/exporter-logs-otlp-proto',
    '@opentelemetry/instrumentation',
    '@opentelemetry/otlp-transformer',
    '@opentelemetry/sdk-events',
    '@opentelemetry/sdk-logs',
    '@opentelemetry/sdk-node'
  ],
  semconv: ['@opentelemetry/semantic-conventions'],
  // These have individual releases in opentelemetry-js-contrib
  contrib: [
    '@opentelemetry/auto-configuration-propagators',
    '@opentelemetry/auto-instrumentations-node',
    '@opentelemetry/baggage-span-processor',
    '@opentelemetry/instrumentation-aws-sdk',
    '@opentelemetry/id-generator-aws-xray',
    '@opentelemetry/propagator-aws-xray',
    '@opentelemetry/resource-detector-aws'
  ]
};

async function main() {
  const packageJsonPath = path.join('aws-distro-opentelemetry-node-autoinstrumentation', 'package.json');
  
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    let updated = false;
    
    // Get versions from GitHub and npm
    const githubVersions = await getLatestOtelVersions();
    
    if (!githubVersions || Object.keys(githubVersions).length === 0) {
      console.error('Failed to get latest OpenTelemetry versions');
      process.exit(1);
    }
    
    // Get all @opentelemetry packages from dependencies
    const dependencies = packageJson.dependencies || {};
    const otelPackages = Object.keys(dependencies).filter(pkg => pkg.startsWith('@opentelemetry/'));
        
    // Update each package
    for (const packageName of otelPackages) {
      const currentVersion = dependencies[packageName];
      let newVersion = null;
      
      // Try to get version from GitHub releases first
      if (PACKAGE_CATEGORIES.api.includes(packageName) && githubVersions.api) {
        newVersion = githubVersions.api;
      } else if (PACKAGE_CATEGORIES.core.includes(packageName) && githubVersions.core) {
        newVersion = githubVersions.core;
      } else if (PACKAGE_CATEGORIES.experimental.includes(packageName) && githubVersions.experimental) {
        newVersion = githubVersions.experimental;
      } else if (PACKAGE_CATEGORIES.semconv.includes(packageName) && githubVersions.semconv) {
        newVersion = githubVersions.semconv;
      } else if (PACKAGE_CATEGORIES.contrib.includes(packageName)) {
        // Independently versioned; check if we have the version from npm
        if (githubVersions[packageName]) {
          newVersion = githubVersions[packageName];
        } else {
          // Fall back to npm registry
          newVersion = await getLatestVersionFromNpm(packageName);
        }
      } else {
        // Fall back to npm registry for any uncategorized packages
        console.log(`Package ${packageName} not categorized, fetching version from npm`);
        newVersion = await getLatestVersionFromNpm(packageName);
      }
      
      if (newVersion && currentVersion !== newVersion) {
        packageJson.dependencies[packageName] = newVersion;
        updated = true;
        console.log(`Updated ${packageName}: ${currentVersion} → ${newVersion}`);
      } else if (newVersion) {
        console.log(`${packageName} already at latest version: ${newVersion}`);
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
