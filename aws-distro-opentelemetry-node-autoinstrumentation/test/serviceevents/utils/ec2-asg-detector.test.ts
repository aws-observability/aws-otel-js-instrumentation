// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Ec2AutoScalingGroupDetector, EC2_ASG_ATTRIBUTE } from '../../../src/serviceevents/utils/ec2-asg-detector';

/**
 * The custom EC2 ASG detector fetches aws:autoscaling:groupName from IMDS instance
 * tags (the stock OTel awsEc2Detector does not), so the SDK resource carries the same
 * ASG the CloudWatch agent uses to resolve ec2:<asg>.
 */
describe('Ec2AutoScalingGroupDetector', function () {
  let server: http.Server;
  let host: string;

  function startImds(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, done: () => void) {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      host = `127.0.0.1:${port}`;
      done();
    });
  }

  afterEach(function (done: Mocha.Done) {
    if (server) server.close(() => done());
    else done();
  });

  // Resolve the (possibly Promise) attribute value the detector returns.
  async function detectAsg(): Promise<unknown> {
    const detector = new Ec2AutoScalingGroupDetector(host);
    const detected = detector.detect();
    return await (detected.attributes?.[EC2_ASG_ATTRIBUTE] as Promise<unknown>);
  }

  it('fetches the ASG from IMDS instance tags (token + tag value)', function (done: Mocha.Done) {
    startImds(
      (req, res) => {
        if (req.method === 'PUT' && req.url === '/latest/api/token') {
          res.writeHead(200);
          res.end('fake-token');
        } else if (req.url === '/latest/meta-data/tags/instance/aws:autoscaling:groupName') {
          expect(req.headers['x-aws-ec2-metadata-token']).toBe('fake-token');
          res.writeHead(200);
          res.end('my-asg');
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async () => {
        const asg = await detectAsg();
        expect(asg).toBe('my-asg');
        done();
      }
    );
  });

  it('returns undefined when instance tags are not enabled (404 on tag path)', function (done: Mocha.Done) {
    startImds(
      (req, res) => {
        if (req.method === 'PUT' && req.url === '/latest/api/token') {
          res.writeHead(200);
          res.end('fake-token');
        } else {
          res.writeHead(404); // instance metadata tags disabled
          res.end();
        }
      },
      async () => {
        const asg = await detectAsg();
        expect(asg).toBeUndefined();
        done();
      }
    );
  });

  it('returns undefined when not on EC2 (token endpoint unreachable)', async function () {
    // Point at a closed port — connection refused, mimicking "not on EC2".
    const detector = new Ec2AutoScalingGroupDetector('127.0.0.1:1');
    const detected = detector.detect();
    const asg = await (detected.attributes?.[EC2_ASG_ATTRIBUTE] as Promise<unknown>);
    expect(asg).toBeUndefined();
  });
});
