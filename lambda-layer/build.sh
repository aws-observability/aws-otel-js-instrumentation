#!/bin/bash

set -x

SOURCEDIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
echo "Source directory: ${SOURCEDIR}"

# Navigate to the root project directory
cd "${SOURCEDIR}/.."

# Install dependencies and compile all projects in the repository
echo "Installing dependencies and compiling projects..."
npm install
npm run compile

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
