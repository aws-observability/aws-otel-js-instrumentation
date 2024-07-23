#!/bin/sh

cd ../aws-distro-opentelemetry-autoinstrumentation/
npm install
npm run compile
npm link
cd ../sample-applications/
npm install
npm link @aws-observability/aws-distro-opentelemetry-autoinstrumentation
