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

async function getNpmPackageVersion(packageName) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    const { stdout } = await execAsync(`npm view ${packageName} version`);
    return stdout.trim();
  } catch (error) {
    console.warn(`Warning: Could not get npm version for ${packageName}: ${error.message}`);
    return null;
  }
}

async function getLatestOtelVersions() {
  try {
    // Get versions from opentelemetry-js releases
    const jsReleases = await httpsGet('https://api.github.com/repos/open-telemetry/opentelemetry-js/releases?per_page=100');
    
    console.log('opentelemetry-js releases found:', jsReleases ? jsReleases.length : 'none');
    
    const versions = {};
    
    // Process opentelemetry-js releases
    if (jsReleases) {
      for (const release of jsReleases) {
        const tagName = release.tag_name;
        
        // Core packages: v2.0.0 -> 2.0.0
        if (/^v\d+\.\d+\.\d+$/.test(tagName) && !versions.core) {
          versions.core = tagName.substring(1);
        }
        // Experimental packages: experimental/v0.57.1 -> 0.57.1
        else if (tagName.startsWith('experimental/v') && !versions.experimental) {
          versions.experimental = tagName.substring('experimental/v'.length);
        }
        // API package: api/v1.9.0 -> 1.9.0
        else if (tagName.startsWith('api/v') && !versions.api) {
          versions.api = tagName.substring('api/v'.length);
        }
        // Semantic conventions: semconv/v1.28.0 -> 1.28.0
        else if (tagName.startsWith('semconv/v') && !versions.semconv) {
          versions.semconv = tagName.substring('semconv/v'.length);
        }
      }
    }
    
    // Get contrib package versions from npm, since each one is independently versioned.
    const contribPackages = [
      '@opentelemetry/auto-instrumentations-node',
      '@opentelemetry/instrumentation-aws-lambda',
      '@opentelemetry/instrumentation-aws-sdk',
      '@opentelemetry/resource-detector-aws'
    ];
    
    console.log('Getting opentelemetry-js-contrib versions from npm...');
    for (const packageName of contribPackages) {
      const version = await getNpmPackageVersion(packageName);
      if (version) {
        // Use the full package name as the key for consistency
        versions[packageName] = version;
        console.log(`Found ${packageName}: ${version}`);
      }
    }
    
    return versions;
    
  } catch (error) {
    console.warn(`Warning: Could not get versions: ${error.message}`);
    return {};
  }
}

async function main() {
  const versions = await getLatestOtelVersions();
  
  // Set GitHub outputs
  if (process.env.GITHUB_OUTPUT) {
    const fs = require('fs');
    if (versions.core) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `otel_js_core_version=${versions.core}\n`);
    }
    if (versions.experimental) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `otel_js_experimental_version=${versions.experimental}\n`);
    }
    if (versions.api) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `otel_js_api_version=${versions.api}\n`);
    }
    if (versions.semconv) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `otel_js_semconv_version=${versions.semconv}\n`);
    }
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { getLatestOtelVersions };
