#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getLatestVersionsFromGitHub } = require('./get_upstream_versions.js');

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
    
    // Get all contrib packages we actually depend on
    const contribPackages = {};
    for (const [packageName, version] of Object.entries(dependencies)) {
      if (packageName.startsWith('@opentelemetry/') && 
          !['@opentelemetry/api', '@opentelemetry/sdk-trace-base', '@opentelemetry/sdk-node', '@opentelemetry/semantic-conventions'].includes(packageName)) {
        // Check if it's likely a contrib package (not in core/experimental categories)
        const componentName = packageName.replace('@opentelemetry/', '');
        contribPackages[componentName] = version;
      }
    }
    
    currentVersions.contrib = contribPackages;
    
    return currentVersions;
    
  } catch (error) {
    console.warn(`Error reading current versions: ${error.message}`);
    return {};
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
    const releases = await httpsGet(`https://api.github.com/repos/open-telemetry/${repoName}/releases?per_page=100`);
    if (!releases) return [];
    
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
          
          // Check if release notes mention breaking changes (multiple patterns)
          const body = release.body || '';
          if (body.includes('💥 Breaking Changes') || 
              body.includes('Breaking changes') || 
              body.includes('BREAKING CHANGES')) {
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
    console.warn(`Warning: Could not get releases for ${repoName}: ${error.message}`);
    return [];
  }
}

async function findContribBreakingChanges(currentContribPackages, newContribVersions) {
  try {
    const releases = await httpsGet('https://api.github.com/repos/open-telemetry/opentelemetry-js-contrib/releases?per_page=100');
    if (!releases) return [];
    
    const breakingReleases = [];
    
    for (const release of releases) {
      const tagName = release.tag_name;
      
      // Extract component name and version from releases like "auto-instrumentations-node: v0.64.4"
      const match = tagName.match(/^([^:]+):\s*v(.+)$/);
      if (match) {
        const componentName = match[1];
        const releaseVersion = match[2];
        
        // Check if this is a package we depend on
        if (currentContribPackages[componentName]) {
          const currentVersion = currentContribPackages[componentName];
          const newVersion = newContribVersions[componentName];
          
          if (newVersion && 
              compareVersions(releaseVersion, currentVersion) > 0 && 
              compareVersions(releaseVersion, newVersion) <= 0) {
            
            // Check if release notes mention breaking changes (multiple patterns)
            const body = release.body || '';
            if (body.includes('⚠ BREAKING CHANGES') || 
                body.includes('Breaking changes') || 
                body.includes('BREAKING CHANGES')) {
              breakingReleases.push({
                component: componentName,
                version: releaseVersion,
                name: release.name || tagName,
                url: release.html_url
              });
            }
          }
        }
      }
    }
    
    return breakingReleases;
    
  } catch (error) {
    console.warn(`Warning: Could not get contrib releases: ${error.message}`);
    return [];
  }
}

async function main() {
  console.log('Getting latest versions from GitHub...');
  const latestVersions = await getLatestVersionsFromGitHub();
  
  const currentVersions = getCurrentVersionsFromPackageJson();
  
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
      breakingInfo += '**opentelemetry-js (core):**\n';
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
      breakingInfo += '**opentelemetry-js (experimental):**\n';
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
      breakingInfo += '**opentelemetry-js (api):**\n';
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
      breakingInfo += '**opentelemetry-js (semconv):**\n';
      for (const release of semconvBreaking) {
        breakingInfo += `- [${release.name}](${release.url})\n`;
      }
    }
  }
  
  // Check contrib releases for packages we actually depend on
  if (currentVersions.contrib) {
    const contribBreaking = await findContribBreakingChanges(currentVersions.contrib, latestVersions);
    
    if (contribBreaking.length > 0) {
      breakingInfo += '**opentelemetry-js-contrib:**\n';
      for (const release of contribBreaking) {
        breakingInfo += `- [${release.name}](${release.url})\n`;
      }
    }
  }
  
  // Set GitHub output
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `breaking_changes_info<<EOF\n${breakingInfo}EOF\n`);
  }
  
  if (breakingInfo) {
    console.log('Breaking changes found');
  } else {
    console.log('No breaking changes found');
  }
}

if (require.main === module) {
  main().catch(console.error);
}
