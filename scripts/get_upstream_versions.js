#!/usr/bin/env node

const fs = require('fs');

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

async function getLatestVersionsFromGitHub() {
  try {
    // Get versions from opentelemetry-js releases
    const jsReleases = await httpsGet('https://api.github.com/repos/open-telemetry/opentelemetry-js/releases?per_page=100');
    const contribReleases = await httpsGet('https://api.github.com/repos/open-telemetry/opentelemetry-js-contrib/releases?per_page=100');
    
    console.log('JS releases found:', jsReleases ? jsReleases.length : 'none');
    console.log('Contrib releases found:', contribReleases ? contribReleases.length : 'none');
    
    const versions = {};
    
    // Process opentelemetry-js releases
    if (jsReleases) {
      for (const release of jsReleases) {
        const tagName = release.tag_name;
        
        // Core packages: v2.0.0 -> 2.0.0 (only keep first/newest)
        if (/^v\d+\.\d+\.\d+$/.test(tagName) && !versions.core) {
          versions.core = tagName.substring(1);
        }
        // Experimental packages: experimental/v0.57.1 -> 0.57.1 (only keep first/newest)
        else if (tagName.startsWith('experimental/v') && !versions.experimental) {
          versions.experimental = tagName.substring('experimental/v'.length);
        }
        // API package: api/v1.9.0 -> 1.9.0 (only keep first/newest)
        else if (tagName.startsWith('api/v') && !versions.api) {
          versions.api = tagName.substring('api/v'.length);
        }
        // Semantic conventions: semconv/v1.28.0 -> 1.28.0 (only keep first/newest)
        else if (tagName.startsWith('semconv/v') && !versions.semconv) {
          versions.semconv = tagName.substring('semconv/v'.length);
        }
      }
    }
    
    // Process opentelemetry-js-contrib releases
    if (contribReleases) {
      for (const release of contribReleases) {
        const tagName = release.tag_name;
        
        // Extract component name and version from releases like "auto-instrumentations-node: v0.64.4"
        const match = tagName.match(/^([^:]+):\s*v(.+)$/);
        if (match) {
          const componentName = match[1];
          const version = match[2];
          if (!versions[componentName]) {
            versions[componentName] = version;
          }
        }
      }
    }
    
    console.log('Found GitHub release versions:', versions);
    
    return versions;
    
  } catch (error) {
    console.warn(`Warning: Could not get GitHub releases: ${error.message}`);
    return {};
  }
}

async function main() {
  await getLatestVersionsFromGitHub();
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { getLatestVersionsFromGitHub };
