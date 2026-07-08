// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as http from 'http';
import { AddressInfo } from 'net';
import { EcsClusterDetector } from '../../../src/serviceevents/utils/ecs-cluster-detector';

/**
 * The EcsClusterDetector reads the ECS task metadata endpoint and emits aws.ecs.cluster.arn
 * (+ cloud.platform=aws_ecs) as PER-KEY promises — working around the upstream AwsEcsDetector
 * which returns attributes as a single Promise that ResourceImpl drops.
 */
describe('EcsClusterDetector', function () {
  let server: http.Server;
  let baseUri: string;

  function startMetadata(handler: http.RequestListener, done: () => void) {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      baseUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  }

  afterEach(function (done: Mocha.Done) {
    if (server) server.close(() => done());
    else done();
  });

  async function detectArn(uri: string): Promise<unknown> {
    const detected = new EcsClusterDetector(uri).detect();
    return await (detected.attributes?.['aws.ecs.cluster.arn'] as Promise<unknown>);
  }

  it('derives the cluster ARN from the task ARN when Cluster is a bare name', function (done: Mocha.Done) {
    startMetadata(
      (req, res) => {
        if (req.url === '/task') {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              Cluster: 'my-ecs',
              TaskARN: 'arn:aws:ecs:us-west-2:123456789012:task/my-ecs/abcdef',
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async () => {
        const arn = await detectArn(baseUri);
        expect(arn).toBe('arn:aws:ecs:us-west-2:123456789012:cluster/my-ecs');
        done();
      }
    );
  });

  it('uses Cluster directly when it is already a full ARN', function (done: Mocha.Done) {
    startMetadata(
      (req, res) => {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            Cluster: 'arn:aws:ecs:us-west-2:1:cluster/already-arn',
            TaskARN: 'arn:aws:ecs:us-west-2:1:task/already-arn/x',
          })
        );
      },
      async () => {
        expect(await detectArn(baseUri)).toBe('arn:aws:ecs:us-west-2:1:cluster/already-arn');
        done();
      }
    );
  });

  it('sets cloud.platform=aws_ecs only when a cluster resolved', function (done: Mocha.Done) {
    startMetadata(
      (req, res) => {
        res.writeHead(200);
        res.end(JSON.stringify({ Cluster: 'c', TaskARN: 'arn:aws:ecs:us-west-2:1:task/c/x' }));
      },
      async () => {
        const detected = new EcsClusterDetector(baseUri).detect();
        expect(await (detected.attributes?.['cloud.platform'] as Promise<unknown>)).toBe('aws_ecs');
        done();
      }
    );
  });

  it('contributes nothing when not on ECS (no metadata URI)', async function () {
    const detected = new EcsClusterDetector(undefined).detect();
    expect(Object.keys(detected.attributes ?? {})).toHaveLength(0);
  });

  it('resolves undefined when the metadata endpoint is unreachable', async function () {
    // Closed port → connection refused.
    const arn = await detectArn('http://127.0.0.1:1');
    expect(arn).toBeUndefined();
  });
});
