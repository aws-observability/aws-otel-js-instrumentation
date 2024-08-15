// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Modifications Copyright The OpenTelemetry Authors. Licensed under the Apache License 2.0 License.

import * as assert from 'assert';
import { spawnSync, SpawnSyncReturns } from 'child_process';

// The OpenTelemetry Authors code
describe('RegisterPatch', function () {
  it('Correctly applies AWS SDK Patches and generates expected attributes for S3, Kinesis, and SQS Client calls', () => {
    const proc: SpawnSyncReturns<Buffer> = spawnSync(
      process.execPath,
      ['--require', '../build/src/register.js', './test-app/app-aws-sdk-client-calls.js'],
      {
        cwd: __dirname,
        timeout: 10000,
        killSignal: 'SIGKILL', // SIGTERM is not sufficient to terminate some hangs
        env: Object.assign({}, process.env, {
          OTEL_NODE_RESOURCE_DETECTORS: 'none',
          OTEL_TRACES_EXPORTER: 'console',
          // nx (used by lerna run) defaults `FORCE_COLOR=true`, which in
          // node v18.17.0, v20.3.0 and later results in ANSI color escapes
          // in the ConsoleSpanExporter output that is checked below.
          FORCE_COLOR: '0',

          OTEL_LOG_LEVEL: 'ALL',
          OTEL_TRACES_SAMPLER: 'always_on',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4316/v1/traces',
          OTEL_RESOURCE_ATTRIBUTES: 'service.name=test-adot-sdk-ec2-service-name',
          OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'true',
          OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'fs',
        }),
      }
    );
    assert.ifError(proc.error);
    assert.equal(proc.status, 0, `proc.status (${proc.status})`);
    assert.equal(proc.signal, null, `proc.signal (${proc.signal})`);

    assert.ok(proc.stdout.includes('AWS Distro of OpenTelemetry automatic instrumentation started successfully'));
    assert.ok(proc.stdout.includes("Environment variable OTEL_EXPORTER_OTLP_PROTOCOL is set to 'http/protobuf'"));
    assert.ok(proc.stdout.includes("Environment variable OTEL_PROPAGATORS is set to 'xray,tracecontext,b3,b3multi'"));

    assert.ok(
      proc.stdout.includes("'service.name': 'test-adot-sdk-ec2-service-name'"),
      'console span output in stdout - validate service.name'
    );

    assert.ok(
      proc.stdout.includes("'aws.s3.bucket': 'test-bucket-not-exists'"),
      'console span output in stdout - validate aws.s3.bucket'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.resource.type': 'AWS::S3::Bucket'"),
      'console span output in stdout - validate aws.remote.resource.type'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.resource.identifier': 'test-bucket-not-exists'"),
      'console span output in stdout - validate aws.remote.resource.identifier'
    );

    assert.ok(
      proc.stdout.includes("'aws.kinesis.stream.name': 'my-kinesis-stream'"),
      'console span output in stdout - validate aws.kinesis.stream.name'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.resource.type': 'AWS::Kinesis::Stream'"),
      'console span output in stdout - validate aws.remote.resource.type'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.resource.identifier': 'my-kinesis-stream'"),
      'console span output in stdout - validate aws.remote.resource.identifier'
    );

    assert.ok(
      proc.stdout.includes("'aws.sqs.queue.url': 'https://sqs.us-east-1.amazonaws.com/012345678910/sqs-queue-name'"),
      'console span output in stdout - validate aws.sqs.queue.url'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.resource.type': 'AWS::SQS::Queue'"),
      'console span output in stdout - validate aws.remote.resource.type'
    );
    assert.ok(
      proc.stdout.includes("'aws.remote.resource.identifier': 'sqs-queue-name'"),
      'console span output in stdout - validate aws.remote.resource.identifier'
    );
  });
});
// END The OpenTelemetry Authors code
