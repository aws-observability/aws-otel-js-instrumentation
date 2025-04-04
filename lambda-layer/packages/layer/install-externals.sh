#!/bin/bash

set -euf -o pipefail

# Space separated list of external NPM packages

# import-in-the-middle's hook.mjs is used as a module loader for ESM-based handlers and must be available at runtime,
# so we have to install it a standalone package separate from the bundled layer.
EXTERNAL_PACKAGES=( "import-in-the-middle" )

for EXTERNAL_PACKAGE in "${EXTERNAL_PACKAGES[@]}"
do
  echo "Installing external package $EXTERNAL_PACKAGE ..."

  PACKAGE_VERSION=$(npm query "#$EXTERNAL_PACKAGE" \
    | grep version \
    | head -1 \
    | awk -F: '{ print $2 }' \
    | sed 's/[",]//g')

  echo "Resolved version of the external package $EXTERNAL_PACKAGE: $PACKAGE_VERSION"

  npm install "$EXTERNAL_PACKAGE@$PACKAGE_VERSION" --prefix ./build/workspace/nodejs --production --ignore-scripts

  echo "Installed external package $EXTERNAL_PACKAGE"
done
