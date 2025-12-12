#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

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

function getCurrentVersionsFromPackageJson() {
  try {
    const packageJsonPath = path.join('aws-distro-opentelemetry-node-autoinstrumentation', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    
    const dependencies = packageJson.dependencies || {};
    
    // Find representative versions for each category
    const currentVersions = {};
    
    // API version
    if (dependencies['@opentelemetry/api']) {
      currentVersions.api = dependencies['@opentelemetry/api'];
    }
    
    // Core version (use sdk-trace-base as representative)
    if (dependencies['@opentelemetry/sdk-trace-base']) {
      currentVersions.core = dependencies['@opentelemetry/sdk-trace-base'];
    }
    
    // Experimental version (use sdk-node as representative)
    if (dependencies['@opentelemetry/sdk-node']) {
      currentVersions.experimental = dependencies['@opentelemetry/sdk-node'];
    }
    
    // Semconv version
    if (dependencies['@opentelemetry/semantic-conventions']) {
      currentVersions.semconv = dependencies['@opentelemetry/semantic-conventions'];
    }
    
    // Get only contrib packages (independently versioned packages from opentelemetry-js-contrib)
    const contribPackages = {};
    const contribPackageNames = [
      '@opentelemetry/auto-configuration-propagators',
      '@opentelemetry/auto-instrumentations-node',
      '@opentelemetry/baggage-span-processor',
      '@opentelemetry/instrumentation-aws-sdk',
      '@opentelemetry/id-generator-aws-xray',
      '@opentelemetry/propagator-aws-xray',
      '@opentelemetry/resource-detector-aws'
    ];
    
    for (const packageName of contribPackageNames) {
      if (dependencies[packageName]) {
        const componentName = packageName.replace('@opentelemetry/', '');
        contribPackages[componentName] = dependencies[packageName];
      }
    }
    
    currentVersions.contrib = contribPackages;
    
    return currentVersions;
    
  } catch (error) {
    console.error(`Error reading current versions: ${error.message}`);
    process.exit(1);
  }
}

function compareVersions(current, target) {
  // Simple version comparison - assumes semver format
  const currentParts = current.split('.').map(Number);
  const targetParts = target.split('.').map(Number);
  
  for (let i = 0; i < Math.max(currentParts.length, targetParts.length); i++) {
    const currentPart = currentParts[i] || 0;
    const targetPart = targetParts[i] || 0;
    
    if (currentPart < targetPart) return -1;
    if (currentPart > targetPart) return 1;
  }
  
  return 0;
}

async function findBreakingChangesInReleases(repoName, currentVersion, newVersion, releasePattern) {
  try {
    const releases = await httpsGet(`https://api.github.com/repos/open-telemetry/${repoName}/releases`);
    
    const breakingReleases = [];
    
    for (const release of releases) {
      const tagName = release.tag_name;
      let releaseVersion = null;
      
      // Extract version based on pattern
      if (releasePattern === 'core' && /^v\d+\.\d+\.\d+$/.test(tagName)) {
        releaseVersion = tagName.substring(1);
      } else if (releasePattern === 'experimental' && tagName.startsWith('experimental/v')) {
        releaseVersion = tagName.substring('experimental/v'.length);
      } else if (releasePattern === 'api' && tagName.startsWith('api/v')) {
        releaseVersion = tagName.substring('api/v'.length);
      } else if (releasePattern === 'semconv' && tagName.startsWith('semconv/v')) {
        releaseVersion = tagName.substring('semconv/v'.length);
      }
      
      if (releaseVersion) {
        // Check if this release is between current and new version
        if (compareVersions(releaseVersion, currentVersion) > 0 && 
            compareVersions(releaseVersion, newVersion) <= 0) {
          
          // Check if release notes have breaking changes as markdown headers
          const body = release.body || '';
          const breakingHeaderRegex = /^#+.*breaking changes/im;
          if (breakingHeaderRegex.test(body)) {
            breakingReleases.push({
              version: releaseVersion,
              name: release.name || tagName,
              url: release.html_url
            });
          }
        }
      }
    }
    
    return breakingReleases;
    
  } catch (error) {
    console.error(`Warning: Could not get releases for ${repoName}: ${error.message}`);
    process.exit(1);
  }
}

async function getNpmVersionsBetween(packageName, currentVersion, newVersion) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    const { stdout } = await execAsync(`npm view ${packageName} versions --json`);
    const allVersions = JSON.parse(stdout);
    
    // Filter versions between current and new
    const relevantVersions = allVersions.filter(version => 
      compareVersions(version, currentVersion) > 0 && 
      compareVersions(version, newVersion) <= 0
    );
    
    return relevantVersions;
  } catch (error) {
    console.error(`Failed to get npm versions for ${packageName}: ${error.message}`);
    process.exit(1);
  }
}

async function getSpecificGitHubRelease(componentName, version) {
  try {
    const tagName = `${componentName}-v${version}`;
    const release = await httpsGet(`https://api.github.com/repos/open-telemetry/opentelemetry-js-contrib/releases/tags/${tagName}`);
    return release;
  } catch (error) {
    console.error(`Error: Could not get GitHub release for ${componentName}-v${version}: ${error.message}`);
    process.exit(1);
  }
}

async function findContribBreakingChanges(currentContribPackages) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    const breakingReleases = [];
    
    for (const [componentName, currentVersion] of Object.entries(currentContribPackages)) {
      const packageName = `@opentelemetry/${componentName}`;
      
      // Get latest version from npm since contrib packages aren't in latestVersions
      let newVersion;
      try {
        const { stdout } = await execAsync(`npm view ${packageName} version`);
        newVersion = stdout.trim();
      } catch (error) {
        continue;
      }
      
      if (currentVersion === newVersion) {
        continue;
      }
      
      // Get all versions between current and new from npm
      const versionsToCheck = await getNpmVersionsBetween(packageName, currentVersion, newVersion);
      
      // Check each version's GitHub release for breaking changes
      for (const version of versionsToCheck) {
        const release = await getSpecificGitHubRelease(componentName, version);
        
        if (release) {
          const body = release.body || '';
          const breakingHeaderRegex = /^#+.*breaking changes/im;
          if (breakingHeaderRegex.test(body)) {
            breakingReleases.push({
              component: componentName,
              version: version,
              name: release.name || `${componentName}-v${version}`,
              url: release.html_url
            });
          }
        }
      }
    }

    return breakingReleases;
    
  } catch (error) {
    console.error(`Warning: Could not get contrib releases: ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log('Using versions from environment...');
  const latestVersions = {
    core: process.env.OTEL_JS_CORE_VERSION,
    experimental: process.env.OTEL_JS_EXPERIMENTAL_VERSION,
    api: process.env.OTEL_JS_API_VERSION,
    semconv: process.env.OTEL_JS_SEMCONV_VERSION
  };
  
  // Filter out undefined values
  Object.keys(latestVersions).forEach(key => {
    if (!latestVersions[key]) {
      delete latestVersions[key];
    }
  });
  
  console.log('Latest versions from environment:', latestVersions);
  
  if (!latestVersions || Object.keys(latestVersions).length === 0) {
    console.error('Failed to get latest versions from environment');
    process.exit(1);
  }
  
  const currentVersions = getCurrentVersionsFromPackageJson();
  
  if (!currentVersions || Object.keys(currentVersions).length === 0) {
    console.error('Failed to get current versions from package.json');
    process.exit(1);
  }
  
  console.log('Checking for breaking changes in JS releases...');
  
  let breakingInfo = '';
  
  // Check core releases
  if (latestVersions.core && currentVersions.core) {
    const coreBreaking = await findBreakingChangesInReleases(
      'opentelemetry-js', 
      currentVersions.core, 
      latestVersions.core, 
      'core'
    );
    
    if (coreBreaking.length > 0) {
      breakingInfo += '\n**opentelemetry-js (core):**\n';
      for (const release of coreBreaking) {
        breakingInfo += `- [${release.name}](${release.url})\n`;
      }
    }
  }
  
  // Check experimental releases
  if (latestVersions.experimental && currentVersions.experimental) {
    const experimentalBreaking = await findBreakingChangesInReleases(
      'opentelemetry-js', 
      currentVersions.experimental, 
      latestVersions.experimental, 
      'experimental'
    );
    
    if (experimentalBreaking.length > 0) {
      breakingInfo += '\n**opentelemetry-js (experimental):**\n';
      for (const release of experimentalBreaking) {
        breakingInfo += `- [${release.name}](${release.url})\n`;
      }
    }
  }
  
  // Check API releases
  if (latestVersions.api && currentVersions.api) {
    const apiBreaking = await findBreakingChangesInReleases(
      'opentelemetry-js', 
      currentVersions.api, 
      latestVersions.api, 
      'api'
    );
    
    if (apiBreaking.length > 0) {
      breakingInfo += '\n**opentelemetry-js (api):**\n';
      for (const release of apiBreaking) {
        breakingInfo += `- [${release.name}](${release.url})\n`;
      }
    }
  }
  
  // Check semconv releases
  if (latestVersions.semconv && currentVersions.semconv) {
    const semconvBreaking = await findBreakingChangesInReleases(
      'opentelemetry-js', 
      currentVersions.semconv, 
      latestVersions.semconv, 
      'semconv'
    );
    
    if (semconvBreaking.length > 0) {
      breakingInfo += '\n**opentelemetry-js (semconv):**\n';
      for (const release of semconvBreaking) {
        breakingInfo += `- [${release.name}](${release.url})\n`;
      }
    }
  }
  
  if (currentVersions.contrib) {
    const contribBreaking = await findContribBreakingChanges(currentVersions.contrib);
    
    if (contribBreaking.length > 0) {
      breakingInfo += '\n**opentelemetry-js-contrib:**\n';
      for (const release of contribBreaking) {
        breakingInfo += `- [${release.name}](${release.url})\n`;
      }
    }
  }
  
  // Set GitHub output
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `breaking_changes_info<<EOF\n${breakingInfo}EOF\n`);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
