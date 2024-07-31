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

# Build and install ADOT JS instrumentation
./scripts/build_and_install_distro.sh

# Install express sample app package and its dependencies
cd ./sample-applications/simple-express-server/
npm install

# create a symbolic link from the globally-installed `@aws/aws-distro-opentelemetry-node-autoinstrumentation``
# to the `node_modules/` of the simple express server application
npm link @aws/aws-distro-opentelemetry-node-autoinstrumentation
