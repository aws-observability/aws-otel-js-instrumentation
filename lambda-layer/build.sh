#!/bin/bash

set -x

SOURCEDIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
echo "Source directory: ${SOURCEDIR}"

# Navigate to the root project directory
cd "${SOURCEDIR}/.."

# Install dependencies and compile all projects in the repository
echo "Installing dependencies and compiling projects..."
rm -rf node_modules
rm -rf ./aws-distro-opentelemetry-node-autoinstrumentation/build
rm -rf ./aws-distro-opentelemetry-node-autoinstrumentation/node_modules
npm install
npm run compile || exit

# Build aws distro tar file
cd aws-distro-opentelemetry-node-autoinstrumentation || exit
rm aws-aws-distro-opentelemetry-node-autoinstrumentation-*.tgz
npm pack || exit

# Install Lambda Layer Build Tool
cd ${SOURCEDIR}/packages || exit
rm -rf build
rm -rf node_modules
npm install || exit

# Build Lambda SDK layer
cd ${SOURCEDIR}/packages/layer || exit
rm -rf build
rm -rf node_modules
npm install || exit

# Build sample apps
cd ${SOURCEDIR}/sample-apps/aws-sdk || exit
rm -rf build
rm -rf node_modules
npm install || exit
