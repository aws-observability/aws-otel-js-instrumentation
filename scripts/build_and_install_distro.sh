#!/bin/sh
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Fail fast
set -e

# Check script is running in scripts
current_path=`pwd`
current_dir="${current_path##*/}"
if [ "$current_dir" != "aws-otel-js-instrumentation" ]; then
  echo "Please run from aws-otel-js-instrumentation dir"
  exit
fi

# Install dependencies and compile all projects in this repostory
npm install
npm run compile

cd ./aws-distro-opentelemetry-node-autoinstrumentation
# This is handy for installing a local copy of the instrumentation for your own NodeJS project. After running this command,
# run `npm link @aws/aws-distro-opentelemetry-node-autoinstrumentation` in your NodeJS project directory to create a symbolic link
# from the globally-installed `@aws/aws-distro-opentelemetry-node-autoinstrumentation` to `node_modules/` of your NodeJS project folder
# See - https://docs.npmjs.com/cli/v10/commands/npm-link
npm link
