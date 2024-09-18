#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Fail fast
set -e

# Check script is running in contract-tests
current_path=`pwd`
current_dir="${current_path##*/}"
if [ "$current_dir" != "aws-otel-js-instrumentation" ]; then
  echo "Please run from aws-otel-js-instrumentation dir"
  exit
fi

# Remove old whl files (excluding distro whl)
rm -rf dist/mock_collector*
rm -rf dist/contract_tests*

# Install python dependency for contract-test
python3 -m pip install pytest
python3 -m pip install pymysql
python3 -m pip install cryptography
python3 -m pip install mysql-connector-python
python3 -m pip install build

# To be clear, install binary for psycopg2 have no negative influence on otel here
# since Otel-Instrumentation running in container that install psycopg2 from source
python3 -m pip install sqlalchemy psycopg2-binary

# Create mock-collector image
cd contract-tests/images/mock-collector
docker build . -t aws-application-signals-mock-collector-nodejs
if [ $? = 1 ]; then
  echo "Docker build for mock collector failed"
  exit 1
fi

# Find and store aws_opentelemetry_distro whl file
cd ../../../dist
DISTRO=(aws-aws-distro-opentelemetry-node-autoinstrumentation-*.tgz)
if [ "$DISTRO" = "aws-aws-distro-opentelemetry-node-autoinstrumentation-*.tgz" ]; then
 echo "Could not find aws_opentelemetry_distro tgz file in dist dir."
 exit 1
fi

# Create application images
cd ..
for dir in contract-tests/images/applications/*
do
  application="${dir##*/}"
  if [ $application = "requests" ]; then
    # docker build . --progress=plain --no-cache -t aws-application-signals-tests-${application}-app -f ${dir}/Dockerfile --build-arg="DISTRO=aws_opentelemetry_distro-0.5.0.dev0-py3-none-any.whl"
    break
  fi
  docker build . --progress=plain --no-cache -t aws-application-signals-tests-${application}-app -f ${dir}/Dockerfile --build-arg="DISTRO=${DISTRO}"
  if [ $? = 1 ]; then
    echo "Docker build for ${application} application failed"
    exit 1
  fi
done

# Build and install mock-collector
cd contract-tests/images/mock-collector
python3 -m build --outdir ../../../dist
cd ../../../dist
python3 -m pip install mock_collector-1.0.0-py3-none-any.whl --force-reinstall

# Build and install contract-tests
cd ../contract-tests/tests
python3 -m build --outdir ../../dist
cd ../../dist
# --force-reinstall causes `ERROR: No matching distribution found for mock-collector==1.0.0`, but uninstalling and reinstalling works pretty reliably.
python3 -m pip uninstall contract-tests -y
python3 -m pip install contract_tests-1.0.0-py3-none-any.whl
