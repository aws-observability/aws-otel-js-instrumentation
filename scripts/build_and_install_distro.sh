#!/bin/sh
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Fail fast
set -ex

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

cd aws-distro-opentelemetry-node-autoinstrumentation
npm pack
cd ..

mkdir -p dist
mv aws-distro-opentelemetry-node-autoinstrumentation/aws-aws-distro-opentelemetry-node-autoinstrumentation-*.tgz dist/

